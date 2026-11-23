import fs from "node:fs";
import https from "node:https";
import { loadVsphereCredentials } from "./credentials.mjs";

const encodeBasic = (username, password) => Buffer.from(`${username}:${password}`, "utf8").toString("base64");
const unwrap = (body) => body?.value ?? body;

// Upstream POST requests are blocked unless they are one of these read-only
// calls. vCenter exposes some reads as POST "actions"; nothing here changes
// vCenter state. Session login/logout and the VI/JSON session-scoped container
// view are the only exceptions, and they affect only this client's own session.
const READ_ONLY_POST_PATHS = new Set([
  "/api/cis/tagging/tag-association?action=list-attached-objects-on-tags"
]);
const VIM_ALLOWED_METHODS = new Set([
  "Login",
  "Logout",
  "CreateContainerView",
  "DestroyView",
  "RetrievePropertiesEx",
  "ContinueRetrievePropertiesEx"
]);
// VI/JSON (vSphere 8.0 U1+) accepts any release path at or below the server's
// own version, so the oldest supported release works against newer vCenters.
const VIM_RELEASE = process.env.VSPHERE_VIM_RELEASE || "8.0.1.0";
const VM_PROPERTIES = [
  "name",
  "parent",
  "config.template",
  "config.createDate",
  "config.instanceUuid",
  "config.annotation",
  "config.guestFullName",
  "config.hardware.numCPU",
  "config.hardware.memoryMB",
  "runtime.powerState",
  "runtime.host",
  "guest.hostName",
  "guest.ipAddress",
  "guest.toolsRunningStatus",
  "summary.storage.committed",
  "summary.storage.uncommitted"
];
const SAFE_ID = /^[A-Za-z0-9:._-]+$/;
const TAG_ASSOCIATION_BATCH = 100;
const DETAIL_CONCURRENCY = 8;

const checkId = (value, label) => {
  const id = String(value ?? "");
  if (!SAFE_ID.test(id)) throw new Error(`Invalid ${label} identifier.`);
  return id;
};

async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const index = next++;
      results[index] = await fn(list[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

// VI/JSON boxes primitives inside anyType fields as {_typeName, _value}.
const vimValue = (val) => (val && typeof val === "object" && "_value" in val ? val._value : val);
const moKey = (ref) => (ref && ref.type && ref.value ? `${ref.type}:${ref.value}` : null);
const lower = (value) => String(value ?? "").toLowerCase();

const tagMatches = (t, { category, tag, tagPrefix } = {}) =>
  (!category || lower(t.category) === lower(category)) &&
  (!tag || lower(t.name) === lower(tag)) &&
  (!tagPrefix || lower(t.name).startsWith(lower(tagPrefix)));

export class VsphereClient {
  constructor({ credentials = loadVsphereCredentials, caFile = process.env.VSPHERE_CA_FILE, observer = () => {}, config = null } = {}) {
    this.credentialsProvider = credentials;
    this.caFile = caFile;
    this.ca = caFile ? fs.readFileSync(caFile) : undefined;
    this.sessionId = null;
    this.loginPromise = null;
    this.config = config;
    this.observer = observer;
  }

  async ensureConfig() {
    if (!this.config) this.config = await this.credentialsProvider();
    return this.config;
  }

  async serverList() {
    const config = await this.ensureConfig();
    const servers = Array.isArray(config.servers) && config.servers.length
      ? config.servers
      : [config.server];
    return [...new Set(servers)];
  }

  clientFor(server) {
    return new VsphereClient({
      credentials: async () => ({ ...(await this.ensureConfig()), server }),
      caFile: this.caFile,
      observer: this.observer
    });
  }

  async request(pathname, { method = "GET", headers = {}, retry = true, body: payload, withHeaders = false } = {}) {
    const started = Date.now();
    if (!this.config) this.config = await this.credentialsProvider();
    const url = new URL(pathname, `${this.config.server.replace(/\/$/, "")}/`);
    if (url.origin !== new URL(this.config.server).origin) throw new Error("Blocked vSphere request outside the configured vCenter origin.");
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload), "utf8");
    const requestHeaders = { accept: "application/json", ...headers };
    if (data) {
      requestHeaders["content-type"] = "application/json";
      requestHeaders["content-length"] = data.length;
    } else if (method === "POST") {
      requestHeaders["content-length"] = 0;
    }
    try {
    const body = await new Promise((resolve, reject) => {
      const req = https.request(url, {
        method, ca: this.ca, rejectUnauthorized: true,
        headers: requestHeaders,
        timeout: 60_000
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => {
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
          if ((res.statusCode ?? 500) >= 400) {
            // Fault type names (e.g. InvalidLogin, NotAuthenticated) are safe to
            // surface; fault messages and bodies are not echoed.
            const fault = typeof parsed?._typeName === "string" ? ` (${parsed._typeName})` : "";
            const error = new Error(`vSphere API returned HTTP ${res.statusCode}${fault} for ${method} ${pathname.split("?")[0]}.`);
            error.statusCode = res.statusCode;
            error.faultType = parsed?._typeName;
            return reject(error);
          }
          resolve(withHeaders ? { body: parsed, headers: res.headers } : parsed);
        });
      });
      req.on("timeout", () => req.destroy(new Error("vSphere API request timed out.")));
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
    this.observer({ endpoint: `${method} ${pathname}`, ok: true, durationMs: Date.now() - started });
    return body;
    } catch (error) {
      this.observer({ endpoint: `${method} ${pathname}`, ok: false, durationMs: Date.now() - started });
      throw error;
    }
  }

  async login() {
    this.config = await this.credentialsProvider();
    const response = await this.request("/rest/com/vmware/cis/session", {
      method: "POST", retry: false,
      headers: { authorization: `Basic ${encodeBasic(this.config.username, this.config.password)}` }
    });
    this.sessionId = unwrap(response);
    if (!this.sessionId) throw new Error("vSphere authentication returned no session.");
    return true;
  }

  async ensureLogin() {
    if (this.sessionId) return;
    this.loginPromise ??= this.login().finally(() => { this.loginPromise = null; });
    await this.loginPromise;
  }

  async get(pathname, retry = true) {
    await this.ensureLogin();
    try {
      return unwrap(await this.request(pathname, { headers: { "vmware-api-session-id": this.sessionId } }));
    } catch (error) {
      if (retry && error.statusCode === 401) {
        this.sessionId = null;
        await this.login();
        return this.get(pathname, false);
      }
      throw error;
    }
  }

  // POST is allowed only for the fixed read-only paths in READ_ONLY_POST_PATHS.
  async postReadOnly(pathname, body, retry = true) {
    if (!READ_ONLY_POST_PATHS.has(pathname)) throw new Error("Blocked vSphere POST outside the read-only allowlist.");
    await this.ensureLogin();
    try {
      return unwrap(await this.request(pathname, {
        method: "POST", body, headers: { "vmware-api-session-id": this.sessionId }
      }));
    } catch (error) {
      if (retry && error.statusCode === 401) {
        this.sessionId = null;
        await this.login();
        return this.postReadOnly(pathname, body, false);
      }
      throw error;
    }
  }

  // ---- Tags (vSphere Automation tagging API) ----

  async tagCatalog() {
    const [categoryIds, tagIds] = await Promise.all([
      this.get("/api/cis/tagging/category"),
      this.get("/api/cis/tagging/tag")
    ]);
    const categories = await mapLimit(categoryIds ?? [], DETAIL_CONCURRENCY, (id) =>
      this.get(`/api/cis/tagging/category/${encodeURIComponent(checkId(id, "category"))}`));
    const tags = await mapLimit(tagIds ?? [], DETAIL_CONCURRENCY, (id) =>
      this.get(`/api/cis/tagging/tag/${encodeURIComponent(checkId(id, "tag"))}`));
    const categoryName = new Map(categories.filter(Boolean).map((c) => [c.id, c.name]));
    return tags.filter(Boolean).map((t) => ({
      id: t.id,
      name: t.name,
      category: categoryName.get(t.category_id) ?? null,
      description: t.description || undefined
    }));
  }

  async tagAssociations(tagIds) {
    const out = [];
    for (const batch of chunk(tagIds, TAG_ASSOCIATION_BATCH)) {
      const result = await this.postReadOnly(
        "/api/cis/tagging/tag-association?action=list-attached-objects-on-tags",
        { tag_ids: batch }
      );
      if (Array.isArray(result)) out.push(...result);
    }
    return out;
  }

  // Returns { tags, vmTags: Map(vmId -> [tag]) } for this vCenter.
  async tagsWithVmAssociations() {
    const tags = await this.tagCatalog();
    const byId = new Map(tags.map((t) => [t.id, { ...t, vmCount: 0, objectCount: 0 }]));
    const vmTags = new Map();
    for (const { tag_id: tagId, object_ids: objects } of await this.tagAssociations([...byId.keys()])) {
      const tag = byId.get(tagId);
      if (!tag) continue;
      for (const object of objects ?? []) {
        tag.objectCount += 1;
        if (object?.type !== "VirtualMachine") continue;
        tag.vmCount += 1;
        if (!vmTags.has(object.id)) vmTags.set(object.id, []);
        vmTags.get(object.id).push({ category: tag.category, name: tag.name });
      }
    }
    return { tags: [...byId.values()], vmTags };
  }

  async listTagsAll({ category, tag_prefix: tagPrefix } = {}) {
    const { results, failures } = await this.acrossServers((client) => client.tagsWithVmAssociations());
    const tags = results.flatMap(({ server, value }) => value.tags
      .filter((t) => tagMatches(t, { category, tagPrefix }))
      .map(({ id, ...t }) => ({ ...t, tagId: id, vCenter: server })))
      .sort((a, b) => lower(a.category).localeCompare(lower(b.category)) || lower(a.name).localeCompare(lower(b.name)));
    return { count: tags.length, tags, failures };
  }

  async listVmTagsAll({ category, tag, tag_prefix: tagPrefix, without = false, vcenter, limit } = {}) {
    const filter = { category, tag, tagPrefix };
    const filtered = Boolean(category || tag || tagPrefix);
    const { results, failures } = await this.acrossServers(async (client, server) => {
      if (vcenter && !lower(server).includes(lower(vcenter))) return null;
      const [vms, { vmTags }] = await Promise.all([client.listVms(), client.tagsWithVmAssociations()]);
      return (vms ?? []).map((vm) => ({
        vm: vm.vm,
        name: vm.name,
        power_state: vm.power_state,
        vCenter: server,
        tags: vmTags.get(vm.vm) ?? []
      }));
    });
    const all = results.flatMap(({ value }) => value ?? []);
    const matching = all.filter((vm) => {
      const hit = filtered ? vm.tags.some((t) => tagMatches(t, filter)) : vm.tags.length > 0;
      return without ? !hit : (filtered ? hit : true);
    });
    const perVCenter = {};
    for (const vm of matching) perVCenter[vm.vCenter] = (perVCenter[vm.vCenter] ?? 0) + 1;
    const max = Number.isInteger(limit) && limit > 0 ? limit : matching.length;
    return {
      filter: { category: category ?? null, tag: tag ?? null, tag_prefix: tagPrefix ?? null, without: Boolean(without), vcenter: vcenter ?? null },
      totalVms: all.length,
      count: matching.length,
      perVCenter,
      truncated: matching.length > max,
      vms: matching.slice(0, max),
      failures
    };
  }

  async acrossServers(operation) {
    const config = await this.ensureConfig();
    const servers = await this.serverList();
    const primary = config.server;
    const settled = await Promise.all(servers.map(async (server) => {
      try {
        const client = server === primary ? this : this.clientFor(server);
        return { server, value: await operation(client, server), ok: true };
      } catch (error) {
        return { server, error: error.message, ok: false };
      }
    }));
    return {
      results: settled.filter((entry) => entry.ok).map(({ server, value }) => ({ server, value })),
      failures: settled.filter((entry) => !entry.ok).map(({ server, error }) => ({ server, error })),
      servers
    };
  }

  connectionStatus() { return this.get("/rest/appliance/system/version"); }

  // vCenter refuses an unfiltered VM list above 4,000 VMs. On any non-auth
  // failure, fall back to listing per cluster plus per standalone host.
  async listVms() {
    try {
      return await this.get("/rest/vcenter/vm");
    } catch (error) {
      if (!error.statusCode || [401, 403, 404].includes(error.statusCode)) throw error;
      return this.listVmsByPlacement();
    }
  }

  async listVmsByPlacement() {
    const [clusters, hosts] = await Promise.all([this.listClusters(), this.listHosts()]);
    const vms = new Map();
    const add = (list) => { for (const vm of list ?? []) vms.set(vm.vm, vm); };
    const clusteredHosts = new Set();
    await mapLimit(clusters ?? [], 4, async ({ cluster }) => {
      const id = encodeURIComponent(checkId(cluster, "cluster"));
      add(await this.get(`/rest/vcenter/vm?filter.clusters=${id}`));
      for (const { host } of (await this.listHostsForCluster(cluster)) ?? []) clusteredHosts.add(host);
    });
    const standalone = (hosts ?? []).filter(({ host }) => !clusteredHosts.has(host));
    await mapLimit(standalone, 4, async ({ host }) => {
      add(await this.get(`/rest/vcenter/vm?filter.hosts=${encodeURIComponent(checkId(host, "host"))}`));
    });
    return [...vms.values()];
  }

  // ---- VM details (VI/JSON API, vSphere 8.0 U1+) ----

  vimPath(type, id, method) {
    return `/sdk/vim25/${VIM_RELEASE}/${type}/${encodeURIComponent(id)}${method ? `/${method}` : ""}`;
  }

  async vimInvoke(type, id, method, body) {
    if (!VIM_ALLOWED_METHODS.has(method)) throw new Error("Blocked VI/JSON method outside the read-only allowlist.");
    const headers = this.vimSessionId ? { "vmware-api-session-id": this.vimSessionId } : {};
    return this.request(this.vimPath(type, id, method), { method: "POST", body, headers, withHeaders: method === "Login" });
  }

  async vimLogin() {
    const config = await this.ensureConfig();
    // ServiceContent is readable without a session.
    this.vimContent = await this.request(this.vimPath("ServiceInstance", "ServiceInstance", "content"));
    const sessionManager = this.vimContent?.sessionManager?.value;
    if (!sessionManager) throw new Error("vCenter VI/JSON API returned no session manager.");
    const { headers } = await this.vimInvoke("SessionManager", sessionManager, "Login", {
      userName: config.username, password: config.password
    });
    this.vimSessionId = headers?.["vmware-api-session-id"];
    if (!this.vimSessionId) throw new Error("vCenter VI/JSON authentication returned no session.");
  }

  async vimLogout() {
    const sessionManager = this.vimContent?.sessionManager?.value;
    if (this.vimSessionId && sessionManager) {
      try { await this.vimInvoke("SessionManager", sessionManager, "Logout"); } catch { /* session expires anyway */ }
    }
    this.vimSessionId = null;
  }

  // Retrieves name/parent for the inventory tree plus VM_PROPERTIES for VMs,
  // using one container view and paged RetrievePropertiesEx calls.
  async vimInventory() {
    await this.vimLogin();
    let view = null;
    try {
      const { propertyCollector, viewManager, rootFolder } = this.vimContent;
      view = await this.vimInvoke("ViewManager", viewManager.value, "CreateContainerView", {
        container: rootFolder,
        type: ["VirtualMachine", "HostSystem", "ComputeResource", "Folder", "Datacenter"],
        recursive: true
      });
      const tree = ["name", "parent"];
      const spec = {
        _typeName: "PropertyFilterSpec",
        propSet: [
          { _typeName: "PropertySpec", type: "VirtualMachine", pathSet: VM_PROPERTIES },
          { _typeName: "PropertySpec", type: "HostSystem", pathSet: tree },
          { _typeName: "PropertySpec", type: "ComputeResource", pathSet: tree },
          { _typeName: "PropertySpec", type: "ClusterComputeResource", pathSet: tree },
          { _typeName: "PropertySpec", type: "Folder", pathSet: tree },
          { _typeName: "PropertySpec", type: "Datacenter", pathSet: tree }
        ],
        objectSet: [{
          _typeName: "ObjectSpec", obj: view, skip: true,
          selectSet: [{ _typeName: "TraversalSpec", name: "traverseView", type: "ContainerView", path: "view", skip: false }]
        }]
      };
      const objects = [];
      let page = await this.vimInvoke("PropertyCollector", propertyCollector.value, "RetrievePropertiesEx", {
        specSet: [spec], options: { _typeName: "RetrieveOptions", maxObjects: 1000 }
      });
      while (page) {
        objects.push(...(page.objects ?? []));
        if (!page.token) break;
        page = await this.vimInvoke("PropertyCollector", propertyCollector.value, "ContinueRetrievePropertiesEx", { token: page.token });
      }
      return objects.map(({ obj, propSet }) => ({
        ref: obj,
        props: Object.fromEntries((propSet ?? []).map(({ name, val }) => [name, vimValue(val)]))
      }));
    } finally {
      if (view) { try { await this.vimInvoke("ContainerView", view.value, "DestroyView"); } catch { /* released at logout */ } }
      await this.vimLogout();
    }
  }

  async vmDetails() {
    const objects = await this.vimInventory();
    const byKey = new Map(objects.map((o) => [moKey(o.ref), o]));
    const parentOf = (ref) => byKey.get(moKey(ref))?.props.parent;
    const nameOf = (ref) => byKey.get(moKey(ref))?.props.name ?? null;
    const datacenterOf = (ref) => {
      for (let cur = ref, depth = 0; cur && depth < 64; cur = parentOf(cur), depth++) {
        if (cur.type === "Datacenter") return nameOf(cur);
      }
      return null;
    };
    // Folder path below the datacenter's root VM folder, e.g. "Prod/App".
    const folderPath = (ref) => {
      const names = [];
      for (let cur = ref, depth = 0; cur && cur.type === "Folder" && depth < 64; cur = parentOf(cur), depth++) {
        if (parentOf(cur)?.type === "Datacenter") break;
        names.unshift(nameOf(cur));
      }
      return names.join("/") || null;
    };
    return objects.filter((o) => o.ref.type === "VirtualMachine").map(({ ref, props: p }) => {
      const host = p["runtime.host"];
      const compute = host ? parentOf(host) : null;
      return {
        vm: ref.value,
        name: p.name ?? null,
        template: Boolean(p["config.template"]),
        power_state: p["runtime.powerState"] ?? null,
        created: p["config.createDate"] ?? null,
        datacenter: datacenterOf(host ?? p.parent),
        cluster: compute?.type === "ClusterComputeResource" ? nameOf(compute) : null,
        host: host ? nameOf(host) : null,
        folder: p.parent ? folderPath(p.parent) : null,
        guest_os: p["config.guestFullName"] ?? null,
        guest_hostname: p["guest.hostName"] ?? null,
        guest_ip: p["guest.ipAddress"] ?? null,
        tools_running: p["guest.toolsRunningStatus"] ?? null,
        cpu_count: p["config.hardware.numCPU"] ?? null,
        memory_MiB: p["config.hardware.memoryMB"] ?? null,
        storage_committed_bytes: p["summary.storage.committed"] ?? null,
        storage_uncommitted_bytes: p["summary.storage.uncommitted"] ?? null,
        instance_uuid: p["config.instanceUuid"] ?? null,
        annotation: p["config.annotation"] || null
      };
    });
  }

  async listVmDetailsAll({ vcenter, datacenter, cluster, name_contains: nameContains, created_after: createdAfter,
    created_before: createdBefore, include_templates: includeTemplates = false, limit } = {}) {
    const after = createdAfter ? Date.parse(createdAfter) : null;
    const before = createdBefore ? Date.parse(createdBefore) : null;
    if (Number.isNaN(after) || Number.isNaN(before)) throw new Error("created_after and created_before must be ISO 8601 dates.");
    const { results, failures } = await this.acrossServers(async (client, server) => {
      if (vcenter && !lower(server).includes(lower(vcenter))) return null;
      return (await client.vmDetails()).map((vm) => ({ ...vm, vCenter: server }));
    });
    const matching = results.flatMap(({ value }) => value ?? []).filter((vm) => {
      if (!includeTemplates && vm.template) return false;
      if (datacenter && lower(vm.datacenter) !== lower(datacenter)) return false;
      if (cluster && lower(vm.cluster) !== lower(cluster)) return false;
      if (nameContains && !lower(vm.name).includes(lower(nameContains))) return false;
      const created = vm.created ? Date.parse(vm.created) : null;
      if (after !== null && !(created !== null && created >= after)) return false;
      if (before !== null && !(created !== null && created < before)) return false;
      return true;
    });
    const max = Number.isInteger(limit) && limit > 0 ? limit : matching.length;
    return {
      count: matching.length,
      truncated: matching.length > max,
      vms: matching.slice(0, max),
      failures
    };
  }

  async connectionStatusAll() {
    const { results, failures, servers } = await this.acrossServers((client) => client.connectionStatus());
    const primary = results[0]?.value ?? {};
    return {
      ...primary,
      configuredVCenters: servers.length,
      onlineVCenters: results.length,
      vCenters: results.map(({ server, value }) => ({ vCenter: server, ...value })),
      failures
    };
  }

  async listAll(resource) {
    const { results, failures } = await this.acrossServers((client) => client[resource]());
    const items = results.flatMap(({ server, value }) =>
      Array.isArray(value) ? value.map((item) => ({ ...item, vCenter: server })) : []);
    if (!items.length && failures.length) {
      const detail = failures.map(({ server, error }) => `${server}: ${error}`).join("; ");
      throw new Error(`No vSphere data was returned. Failed vCenters: ${detail}`);
    }
    return items;
  }

  listAllVms() { return this.listAll("listVms"); }
  listAllHosts() { return this.listAll("listHosts"); }
  listAllClusters() { return this.listAll("listClusters"); }
  listAllDatastores() { return this.listAll("listDatastores"); }
  listAllNetworks() { return this.listAll("listNetworks"); }
  listAllDatacenters() { return this.listAll("listDatacenters"); }

  async inventorySummaryAll() {
    const resources = [
      ["virtualMachines", "listVms"],
      ["hosts", "listHosts"],
      ["clusters", "listClusters"],
      ["datastores", "listDatastores"],
      ["networks", "listNetworks"],
      ["datacenters", "listDatacenters"]
    ];
    const { results, failures, servers } = await this.acrossServers(async (client) => {
      const counts = {};
      await Promise.all(resources.map(async ([key, method]) => {
        const value = await client[method]();
        counts[key] = Array.isArray(value) ? value.length : 0;
      }));
      return counts;
    });
    const total = Object.fromEntries(resources.map(([key]) => [
      key,
      results.reduce((sum, { value }) => sum + (value[key] || 0), 0)
    ]));
    return {
      ...total,
      configuredVCenters: servers.length,
      onlineVCenters: results.length,
      vCenters: results.map(({ server, value }) => ({ vCenter: server, ...value })),
      failures
    };
  }

  async resolveVmId(identifier) {
    const raw = String(identifier ?? "").trim();
    if (!raw) throw new Error("A VM identifier is required.");

    const config = await this.ensureConfig();
    const servers = await this.serverList();
    const primary = config.server;
    const needle = raw.toLowerCase().replace(/\.$/, "");
    const shortNeedle = String(needle).split(".")[0];
    const shortName = (name) => String(name ?? "").split(".")[0].toLowerCase();

    const idHits = [];
    const exactHits = [];
    const shortHits = [];
    const suggestions = [];

    const { results, failures } = await this.acrossServers((client) => client.listVms());
    for (const { server, value: vms } of results) {
      const list = Array.isArray(vms) ? vms : [];
      for (const vm of list) {
        const entry = { server, vm };
        const name = String(vm.name ?? "").toLowerCase();
        if (/^vm-\d+$/.test(raw) && String(vm.vm) === raw) idHits.push(entry);
        if (name === needle) exactHits.push(entry);
        if (shortName(vm.name) === shortNeedle) shortHits.push(entry);
        if (name.includes(shortNeedle)) suggestions.push(entry);
      }
    }

    const unique = (items) => {
      const seen = new Set();
      return items.filter(({ server, vm }) => {
        const key = `${server}|${vm?.vm}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const preferPrimary = (items) => {
      const onPrimary = items.filter((item) => item.server === primary);
      return onPrimary.length ? onPrimary : items;
    };
    const describe = (items) => items.slice(0, 5)
      .map(({ server, vm }) => `${vm.name} (${vm.vm}, ${server})`)
      .join(", ");
    const ambiguous = (items) => {
      throw new Error(`Multiple vSphere VMs match '${raw}': ${describe(items)}. Use the VM id instead.`);
    };

    const ids = preferPrimary(unique(idHits));
    if (ids.length === 1) return ids[0];
    if (ids.length > 1) ambiguous(ids);

    const exact = preferPrimary(unique(exactHits));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) ambiguous(exact);

    const shorts = preferPrimary(unique(shortHits));
    if (shorts.length === 1) return shorts[0];
    if (shorts.length > 1) ambiguous(shorts);

    const similar = unique(suggestions).slice(0, 5);
    let hint = similar.length ? ` Similar names: ${describe(similar)}.` : "";
    if (failures.length) {
      const detail = failures.slice(0, 3)
        .map(({ server, error }) => `${server}: ${error}`)
        .join("; ");
      hint += ` Some vCenters were unavailable: ${detail}.`;
    }
    throw new Error(`No vSphere VM found for '${raw}' across ${servers.length} configured vCenter(s). Check the name or provide the VM id from the owning vCenter.${hint}`);
  }

  async getVm(identifier) {
    const { server, vm } = await this.resolveVmId(identifier);
    const id = String(vm?.vm ?? vm ?? "");
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid VM identifier.");
    const config = await this.ensureConfig();
    const client = server && server !== config.server ? this.clientFor(server) : this;
    const detail = await client.get(`/rest/vcenter/vm/${encodeURIComponent(id)}`);
    return { ...detail, vCenter: server ?? config.server, vmId: id };
  }
  getVmGuestNetworking(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(id))) throw new Error("Invalid VM identifier.");
    return this.get(`/api/vcenter/vm/${encodeURIComponent(id)}/guest/networking/interfaces`);
  }
  listHosts() { return this.get("/rest/vcenter/host"); }
  listClusters() { return this.get("/rest/vcenter/cluster"); }
  listDatastores() { return this.get("/rest/vcenter/datastore"); }
  listNetworks() { return this.get("/rest/vcenter/network"); }
  listDatacenters() { return this.get("/rest/vcenter/datacenter"); }
  listVmsForDatacenter(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(id))) throw new Error("Invalid datacenter identifier.");
    return this.get(`/rest/vcenter/vm?filter.datacenters=${encodeURIComponent(id)}`);
  }
  listHostsForDatacenter(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(id))) throw new Error("Invalid datacenter identifier.");
    return this.get(`/rest/vcenter/host?filter.datacenters=${encodeURIComponent(id)}`);
  }
  listHostsForCluster(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(id))) throw new Error("Invalid cluster identifier.");
    return this.get(`/rest/vcenter/host?filter.clusters=${encodeURIComponent(id)}`);
  }
}
