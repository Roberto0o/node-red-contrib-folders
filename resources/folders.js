(function () {
  "use strict";

  const PLUGIN_ID = "folders";
  const GLOBAL_CONFIG_TYPE = "global-config";
  const GLOBAL_ENV_NAME = "folders";
  const DEFAULT_FLOW_ICON = "red-ui-icons red-ui-icons-flow";
  const LOCAL_STATE_KEY = "node-red-contrib-folders.nativeState";
  const LOCAL_CONFIG_BACKUP_KEY = "node-red-contrib-folders.configBackup";
  const EVENT_NAMESPACE = ".folders-native";
  const Model = window.NodeRedFoldersModel;

  if (!Model) {
    console.error(
      "[folders] folders-model.js did not load. Native Explorer was not changed.",
    );
    return;
  }

  let folderConfig = Model.emptyConfig();
  let configSaveTimer = null;
  let storageRetryTimer = null;
  let attachTimer = null;
  let reconcileTimer = null;
  let decorateTimer = null;
  let menuBindTimer = null;
  let healthTimer = null;
  let nativeObserver = null;
  let started = false;
  let reconciling = false;
  let compatibilityWarningShown = false;
  let storageInvalid = false;
  let loadedFromLocalBackup = false;
  let pendingRename = null;
  let stateUpdateUntil = 0;
  let structureUpdateUntil = 0;
  let treeClickCapture = null;
  let scrollTrackingElement = null;
  let scrollTrackingHandler = null;
  let scrollIntentHandler = null;
  let scrollIntentUntil = 0;
  let pendingExplorerViewport = null;
  let lastExplorerViewport = { top: 0, left: 0 };
  let primarySelectionKey = null;
  let selectionAnchorKey = null;
  let sortMode = "name";
  let sortDirection = "asc";
  let filterMode = "all";
  const editorEventHandlers = [];
  const collapsedFolders = new Set();
  const selectedKeys = new Set();
  const desiredExpansionStates = new WeakMap();
  const deferredExpansionTimers = new Map();

  const native = {
    outline: null,
    tree: null,
    flowRoot: null,
    subflowRoot: null,
    configRoot: null,
    ownedChildren: $(),
    bannerTools: null,
    headerToggle: null,
    searchToolbar: null,
    searchOptions: null,
    controls: null,
    toolbar: null,
    footer: null,
    filterButton: null,
    sortButton: null,
    sortSelect: null,
    sortDirectionButton: null,
    footerStyleButton: null,
    footerDeleteButton: null,
    mode: "explorer",
  };

  function notify(message, type) {
    if (window.RED && RED.notify) {
      RED.notify(message, { type: type || "success", timeout: 3000 });
    } else {
      console.log("[folders]", message);
    }
  }

  function loadLocalState() {
    try {
      const value = JSON.parse(localStorage.getItem(LOCAL_STATE_KEY) || "{}");
      native.mode =
        value.mode === "configuration" || value.mode === "settings"
          ? "configuration"
          : "explorer";
      sortMode = ["name", "created", "updated", "type"].includes(value.sortMode)
        ? value.sortMode
        : "name";
      sortDirection = value.sortDirection === "desc" ? "desc" : "asc";
      filterMode = [
        "all",
        "flows",
        "subflows",
        "shown",
        "hidden",
        "enabled",
        "disabled",
        "locked",
        "unlocked",
      ].includes(value.filterMode)
        ? value.filterMode
        : "all";
      collapsedFolders.clear();
      (Array.isArray(value.collapsed) ? value.collapsed : []).forEach(
        function (key) {
          collapsedFolders.add(String(key));
        },
      );
    } catch (err) {
      native.mode = "explorer";
    }
  }

  function saveLocalState() {
    try {
      localStorage.setItem(
        LOCAL_STATE_KEY,
        JSON.stringify({
          mode: native.mode,
          sortMode: sortMode,
          sortDirection: sortDirection,
          filterMode: filterMode,
          collapsed: Array.from(collapsedFolders),
        }),
      );
    } catch (err) {}
  }

  function makeId() {
    try {
      if (RED.nodes && typeof RED.nodes.id === "function") {
        return RED.nodes.id();
      }
    } catch (err) {}
    return (
      Date.now().toString(16) + Math.random().toString(16).slice(2)
    ).slice(0, 16);
  }

  function ensureEnv(node) {
    if (!Array.isArray(node.env)) {
      node.env = [];
    }
    return node.env;
  }

  function collectGlobalConfigNodes() {
    const result = [];
    const seen = new Set();
    function add(node) {
      if (!node || node.type !== GLOBAL_CONFIG_TYPE || seen.has(node)) {
        return;
      }
      seen.add(node);
      ensureEnv(node);
      if (!node.modules || typeof node.modules !== "object") {
        node.modules = {};
      }
      result.push(node);
    }
    try {
      if (RED.nodes && typeof RED.nodes.eachConfig === "function") {
        RED.nodes.eachConfig(add);
      }
    } catch (err) {}
    try {
      if (RED.nodes && typeof RED.nodes.eachNode === "function") {
        RED.nodes.eachNode(add);
      }
    } catch (err) {}
    try {
      if (RED.nodes && typeof RED.nodes.filterNodes === "function") {
        (RED.nodes.filterNodes({ type: GLOBAL_CONFIG_TYPE }) || []).forEach(
          add,
        );
      }
    } catch (err) {}
    return result;
  }

  function getGlobalConfigNode() {
    const nodes = collectGlobalConfigNodes();
    return (
      nodes.find(function (node) {
        return ensureEnv(node).some(function (entry) {
          return entry && entry.name === GLOBAL_ENV_NAME && entry.value;
        });
      }) ||
      nodes[0] ||
      null
    );
  }

  function createGlobalConfigNode() {
    let definition = null;
    try {
      definition = RED.nodes.getType(GLOBAL_CONFIG_TYPE);
    } catch (err) {}
    if (!definition) {
      return null;
    }
    const node = {
      id: makeId(),
      type: GLOBAL_CONFIG_TYPE,
      env: [],
      modules: {},
      hasUsers: false,
      users: [],
      credentials: { _: {}, map: {} },
      _def: definition,
    };
    const added = RED.nodes.add(node, { source: PLUGIN_ID });
    RED.nodes.dirty(true);
    return added || node;
  }

  function readStoredConfig() {
    storageInvalid = false;
    loadedFromLocalBackup = false;
    let globalConfig = null;
    const candidates = collectGlobalConfigNodes();
    for (let index = 0; index < candidates.length; index += 1) {
      const entry = ensureEnv(candidates[index]).find(function (item) {
        return item && item.name === GLOBAL_ENV_NAME;
      });
      if (!entry || !String(entry.value || "").trim()) {
        continue;
      }
      try {
        globalConfig = Model.normaliseConfig(JSON.parse(entry.value));
        break;
      } catch (err) {
        storageInvalid = true;
        console.error("[folders] Invalid global folders JSON.", err);
        notify(
          "The global folders data is invalid. Repair the global folders environment variable.",
          "error",
        );
        return Model.emptyConfig();
      }
    }
    let backupConfig = null;
    try {
      const backup = localStorage.getItem(LOCAL_CONFIG_BACKUP_KEY);
      if (backup) {
        backupConfig = Model.normaliseConfig(JSON.parse(backup));
      }
    } catch (err) {
      console.warn("[folders] Ignoring invalid local folder backup.", err);
    }
    if (
      backupConfig &&
      (!globalConfig ||
        String(backupConfig.updatedAt || "") >
          String(globalConfig.updatedAt || ""))
    ) {
      loadedFromLocalBackup = true;
      return backupConfig;
    }
    return globalConfig || backupConfig || Model.emptyConfig();
  }

  function writeStoredConfig() {
    const payload = Model.toStorageConfig(folderConfig);
    const encoded = JSON.stringify(payload);
    try {
      localStorage.setItem(LOCAL_CONFIG_BACKUP_KEY, encoded);
    } catch (err) {}
    let node = getGlobalConfigNode();
    if (!node) {
      node = createGlobalConfigNode();
    }
    if (!node) {
      folderConfig = Model.normaliseConfig(payload);
      return false;
    }
    let entry = ensureEnv(node).find(function (item) {
      return item && item.name === GLOBAL_ENV_NAME;
    });
    if (!entry) {
      entry = { name: GLOBAL_ENV_NAME, value: "", type: "json" };
      node.env.push(entry);
    }
    entry.name = GLOBAL_ENV_NAME;
    entry.type = "json";
    entry.value = encoded;
    node.changed = true;
    if (!node.modules || typeof node.modules !== "object") {
      node.modules = {};
    }
    RED.nodes.dirty(true);
    folderConfig = Model.normaliseConfig(payload);
    storageInvalid = false;
    return payload;
  }

  function scheduleStorageRetry() {
    if (!started || storageRetryTimer) {
      return;
    }
    storageRetryTimer = setTimeout(function () {
      storageRetryTimer = null;
      if (started && !saveConfigNow(true)) {
        scheduleStorageRetry();
      }
    }, 250);
  }

  function saveConfigNow(forceRepair) {
    if (configSaveTimer) {
      clearTimeout(configSaveTimer);
      configSaveTimer = null;
    }
    if (storageRetryTimer) {
      clearTimeout(storageRetryTimer);
      storageRetryTimer = null;
    }
    if (storageInvalid && !forceRepair) {
      return false;
    }
    if (forceRepair) {
      storageInvalid = false;
    }
    try {
      syncKnownItems();
      if (!writeStoredConfig()) {
        scheduleStorageRetry();
        return false;
      }
      return true;
    } catch (err) {
      console.error("[folders] Could not save folder data.", err);
      notify(
        "Folder data could not be saved. See the browser console.",
        "error",
      );
      return false;
    }
  }

  function scheduleConfigSave(explicitChange) {
    if (storageInvalid && !explicitChange) {
      return;
    }
    if (explicitChange) {
      storageInvalid = false;
      saveConfigNow(true);
      return;
    }
    if (configSaveTimer) {
      clearTimeout(configSaveTimer);
    }
    configSaveTimer = setTimeout(saveConfigNow, 150);
  }

  function getWorkspaces() {
    const result = [];
    const seen = new Set();
    function add(node) {
      if (
        node &&
        node.id &&
        (!node.type || node.type === "tab") &&
        !seen.has(node.id)
      ) {
        seen.add(node.id);
        result.push(node);
      }
    }
    try {
      RED.nodes.eachWorkspace(add);
    } catch (err) {}
    try {
      if (RED.nodes && typeof RED.nodes.eachNode === "function") {
        RED.nodes.eachNode(function (node) {
          if (node && node.type === "tab") {
            add(node);
          }
        });
      }
    } catch (err) {}
    try {
      (RED.nodes.getWorkspaceOrder() || []).forEach(function (id) {
        add(findWorkspace(id));
      });
    } catch (err) {}
    return result;
  }

  function getSubflows() {
    const result = [];
    const seen = new Set();
    function add(node) {
      if (
        node &&
        node.id &&
        (!node.type || node.type === "subflow") &&
        !seen.has(node.id)
      ) {
        seen.add(node.id);
        result.push(node);
      }
    }
    try {
      RED.nodes.eachSubflow(add);
    } catch (err) {}
    try {
      if (RED.nodes && typeof RED.nodes.eachNode === "function") {
        RED.nodes.eachNode(function (node) {
          if (node && node.type === "subflow") {
            add(node);
          }
        });
      }
    } catch (err) {}
    return result;
  }

  function findWorkspace(id) {
    try {
      return RED.nodes.workspace(id) || null;
    } catch (err) {}
    try {
      return RED.nodes.getWorkspace(id) || null;
    } catch (err) {}
    return null;
  }

  function findSubflow(id) {
    try {
      return RED.nodes.subflow(id) || null;
    } catch (err) {}
    return null;
  }

  function itemLabel(node) {
    return String((node && (node.label || node.name || node.id)) || "Unnamed");
  }

  function syncKindItems(kind, nodes) {
    const target = Model.stores(folderConfig, kind).items;
    const live = new Set();
    let changed = false;
    nodes.forEach(function (node) {
      live.add(node.id);
      if (!target[node.id]) {
        Model.setItemPath(folderConfig, kind, node.id, "", itemLabel(node));
        changed = true;
      } else if (target[node.id].name !== itemLabel(node)) {
        target[node.id].name = itemLabel(node);
        target[node.id].updatedAt = new Date().toISOString();
        changed = true;
      }
    });
    return changed;
  }

  function syncKnownItems() {
    folderConfig = Model.normaliseConfig(folderConfig);
    const flowsChanged = syncKindItems("flow", getWorkspaces());
    const subflowsChanged = syncKindItems("subflow", getSubflows());
    let combinedFoldersChanged = false;
    const flowFolders = Model.stores(folderConfig, "flow").folders;
    const subflowStore = Model.stores(folderConfig, "subflow");
    const combinedPaths = new Set(Object.keys(subflowStore.folders));
    Object.keys(subflowStore.items).forEach(function (id) {
      const path = Model.normalisePath(subflowStore.items[id].path);
      if (path) {
        combinedPaths.add(path);
      }
    });
    combinedPaths.forEach(function (path) {
      if (!flowFolders[path]) {
        Model.ensureFolder(
          folderConfig,
          "flow",
          path,
          subflowStore.folders[path] || {},
        );
        combinedFoldersChanged = true;
      }
    });
    folderConfig = Model.rebuildIndexes(folderConfig);
    return flowsChanged || subflowsChanged || combinedFoldersChanged;
  }

  function nativeNode(kind, id) {
    return kind === "subflow" ? findSubflow(id) : findWorkspace(id);
  }

  function normaliseVisibleIndent(item, hiddenLevels) {
    if (item && item.treeList && item.treeList.labelPadding) {
      item.treeList.labelPadding.width(
        Math.max(0, (Number(item.depth) - hiddenLevels) * 12) + "px",
      );
    }
    (item && Array.isArray(item.children) ? item.children : []).forEach(
      function (child) {
        normaliseVisibleIndent(child, hiddenLevels);
      },
    );
  }

  function findNativeExplorer() {
    let result = null;
    $(".red-ui-info-outline").each(function () {
      if (result) {
        return false;
      }
      const outline = $(this);
      const tree = outline.children(".red-ui-treeList").first();
      if (!tree.length || typeof tree.treeList !== "function") {
        return;
      }
      try {
        const data = tree.treeList("data");
        if (
          Array.isArray(data) &&
          data.some(function (item) {
            return item && item.id === "__subflow__";
          }) &&
          data.some(function (item) {
            return item && item.id === "__global__";
          })
        ) {
          result = { outline: outline, tree: tree, data: data };
        }
      } catch (err) {}
    });
    return result;
  }

  function refreshNativeRoots() {
    if (!native.tree || !native.tree.length) {
      return false;
    }
    try {
      const data = native.tree.treeList("data");
      native.subflowRoot = data.find(function (item) {
        return item && item.id === "__subflow__";
      });
      native.configRoot = data.find(function (item) {
        return item && item.id === "__global__";
      });
      native.flowRoot = data.find(function (item) {
        return item && !item.id && Array.isArray(item.children);
      });
      if (
        native.flowRoot &&
        native.flowRoot.treeList &&
        native.flowRoot.treeList.container
      ) {
        native.flowRoot.treeList.container.addClass(
          "folders-native-combined-root",
        );
        native.flowRoot.treeList.container
          .closest("li")
          .addClass("folders-native-flow-root-item");
      }
      if (
        native.subflowRoot &&
        native.subflowRoot.treeList &&
        native.subflowRoot.treeList.container
      ) {
        native.subflowRoot.treeList.container.addClass(
          "folders-native-subflow-source-root",
        );
        native.subflowRoot.treeList.container
          .closest("li")
          .addClass("folders-native-subflow-root-item");
      }
      if (
        native.configRoot &&
        native.configRoot.treeList &&
        native.configRoot.treeList.container
      ) {
        native.configRoot.treeList.container.addClass(
          "folders-native-config-root",
        );
        native.configRoot.treeList.container
          .closest("li")
          .addClass("folders-native-config-root-item");
        setItemExpandedInstant(native.configRoot, true);
        (native.configRoot.children || []).forEach(function (typeGroup) {
          if (typeGroup && typeGroup.treeList && typeGroup.treeList.container) {
            typeGroup.treeList.container.addClass("folders-native-config-type");
            normaliseVisibleIndent(typeGroup, 1);
            (typeGroup.children || []).forEach(function (configItem) {
              normaliseVisibleIndent(configItem, 1);
            });
          }
        });
      }
      setRootListItemVisible(native.flowRoot, native.mode === "explorer");
      setRootListItemVisible(native.subflowRoot, false);
      setRootListItemVisible(
        native.configRoot,
        native.mode === "configuration",
      );
      return !!(
        native.flowRoot &&
        native.flowRoot.treeList &&
        native.subflowRoot &&
        native.subflowRoot.treeList &&
        native.configRoot &&
        native.configRoot.treeList
      );
    } catch (err) {
      return false;
    }
  }

  function collectNativeItems(root, kind) {
    const result = [];
    const seen = new Set();
    function visit(item) {
      if (!item) {
        return;
      }
      if (item.__foldersFolder) {
        (item.children || []).forEach(visit);
        return;
      }
      if (item.id && nativeNode(kind, item.id)) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          result.push(item);
        }
      }
    }
    (root && Array.isArray(root.children) ? root.children.slice() : []).forEach(
      visit,
    );
    return result;
  }

  function removeTreeItem(item, detach) {
    if (item && item.treeList && typeof item.treeList.remove === "function") {
      item.treeList.remove(!!detach);
      return;
    }
    if (item && item.parent && Array.isArray(item.parent.children)) {
      const index = item.parent.children.indexOf(item);
      if (index !== -1) {
        item.parent.children.splice(index, 1);
      }
    }
  }

  function removePluginFolder(item) {
    (Array.isArray(item.children)
      ? item.children.slice().reverse()
      : []
    ).forEach(function (child) {
      if (child.__foldersFolder) {
        removePluginFolder(child);
      } else {
        removeTreeItem(child, false);
      }
    });
    removeTreeItem(item, false);
  }

  function folderStateKey(kind, path) {
    return kind + ":" + Model.normalisePath(path);
  }

  function boolProperty(flow, names) {
    for (let index = 0; index < names.length; index += 1) {
      if (flow && flow[names[index]] !== undefined) {
        return !!flow[names[index]];
      }
    }
    return false;
  }

  function isHidden(flow) {
    if (!flow) {
      return false;
    }
    if (flow.type === "subflow") {
      const record = nativeItemMeta("subflow", flow.id);
      if (record && record.hidden) {
        return true;
      }
    }
    try {
      if (RED.workspaces && typeof RED.workspaces.isHidden === "function") {
        return !!RED.workspaces.isHidden(flow.id);
      }
    } catch (err) {}
    return boolProperty(flow, ["hidden", "hide"]);
  }

  function isDisabled(flow) {
    return boolProperty(flow, ["disabled", "disable"]);
  }

  function isLocked(flow) {
    return boolProperty(flow, ["locked", "lock"]);
  }

  function flowsInFolder(path, includeSubflows) {
    const cleanPath = Model.normalisePath(path);
    const flows = getWorkspaces().filter(function (flow) {
      const meta = nativeItemMeta("flow", flow.id) || {};
      const itemPath = Model.normalisePath(meta.path);
      return itemPath === cleanPath || itemPath.indexOf(cleanPath + "/") === 0;
    });
    if (includeSubflows) {
      getSubflows().forEach(function (subflow) {
        const meta = nativeItemMeta("subflow", subflow.id) || {};
        const itemPath = Model.normalisePath(meta.path);
        if (itemPath === cleanPath || itemPath.indexOf(cleanPath + "/") === 0) {
          flows.push(subflow);
        }
      });
    }
    return flows;
  }

  function folderAllActive(path, state) {
    const flows = flowsInFolder(path, state === "hidden");
    if (!flows.length) {
      const record =
        Model.stores(folderConfig, "flow").folders[Model.normalisePath(path)] ||
        {};
      return !!record[state];
    }
    return flows.every(function (flow) {
      return state === "hidden"
        ? isHidden(flow)
        : state === "disabled"
          ? isDisabled(flow)
          : isLocked(flow);
    });
  }

  function setFlowState(flow, state, active) {
    if (!flow || (flow.type === "subflow" && state !== "hidden")) {
      return;
    }
    try {
      if (state === "hidden") {
        if (flow.type === "subflow") {
          const record = nativeItemMeta("subflow", flow.id);
          if (record) {
            record.hidden = !!active;
            record.updatedAt = new Date().toISOString();
          }
          if (
            RED.workspaces &&
            typeof RED.workspaces.contains === "function" &&
            RED.workspaces.contains(flow.id)
          ) {
            if (active) {
              RED.workspaces.hide(flow.id);
            } else {
              RED.workspaces.show(flow.id, null, true);
            }
          }
          return;
        }
        if (isHidden(flow) !== active) {
          if (active) {
            RED.workspaces.hide(flow.id);
          } else {
            RED.workspaces.show(flow.id, null, true);
          }
        }
      } else if (state === "disabled") {
        const wasLocked = isLocked(flow);
        if (wasLocked) {
          RED.workspaces.unlock(flow.id);
        }
        if (isDisabled(flow) !== active) {
          if (active) {
            RED.workspaces.disable(flow.id);
          } else {
            RED.workspaces.enable(flow.id);
          }
        }
        if (wasLocked) {
          RED.workspaces.lock(flow.id);
        }
      } else if (isLocked(flow) !== active) {
        const wasDisabled = isDisabled(flow);
        if (active) {
          RED.workspaces.lock(flow.id);
        } else {
          RED.workspaces.unlock(flow.id);
        }
        // Keep the disabled state independent from locking.
        if (wasDisabled && !isDisabled(flow)) {
          if (isLocked(flow)) {
            RED.workspaces.unlock(flow.id);
            RED.workspaces.disable(flow.id);
            RED.workspaces.lock(flow.id);
          } else {
            RED.workspaces.disable(flow.id);
          }
        }
      }
    } catch (err) {
      notify("Could not update flow state.", "error");
    }
  }

  function setStoredFolderState(path, state, active) {
    const cleanPath = Model.normalisePath(path);
    ["flow", "subflow"].forEach(function (kind) {
      const folders = Model.stores(folderConfig, kind).folders;
      Object.keys(folders).forEach(function (folderPath) {
        if (
          folderPath === cleanPath ||
          folderPath.indexOf(cleanPath + "/") === 0
        ) {
          folders[folderPath][state] = !!active;
          folders[folderPath].updatedAt = new Date().toISOString();
        }
      });
    });
  }

  function stateSelectionEntries(clickedKey) {
    const keys = selectedKeys.has(clickedKey)
      ? Array.from(selectedKeys)
      : [clickedKey];
    return keys.map(selectionEntry).filter(Boolean);
  }

  function stateTargets(entries, state) {
    const targets = [];
    const seen = new Set();
    function add(kind, node) {
      if (!node || (kind === "subflow" && state !== "hidden")) {
        return;
      }
      const key = kind + ":" + node.id;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push(node);
      }
    }
    entries.forEach(function (entry) {
      if (entry.type === "folder") {
        flowsInFolder(entry.id, state === "hidden").forEach(function (node) {
          add(node.type === "subflow" ? "subflow" : "flow", node);
        });
      } else {
        add(entry.type, nativeNode(entry.type, entry.id));
      }
    });
    return targets;
  }

  function applyStateToSelection(clickedKey, state) {
    const entries = stateSelectionEntries(clickedKey);
    const targets = stateTargets(entries, state);
    const folderEntries = entries.filter(function (entry) {
      return entry.type === "folder";
    });
    const allActive = targets.length
      ? targets.every(function (flow) {
          return state === "hidden"
            ? isHidden(flow)
            : state === "disabled"
              ? isDisabled(flow)
              : isLocked(flow);
        })
      : folderEntries.length > 0 &&
        folderEntries.every(function (entry) {
          return folderAllActive(entry.id, state);
        });
    const active = !allActive;
    stateUpdateUntil = Date.now() + 900;
    folderEntries.forEach(function (entry) {
      setStoredFolderState(entry.id, state, active);
    });
    targets.forEach(function (flow) {
      setFlowState(flow, state, active);
    });
    scheduleConfigSave(true);
    [0, 80, 220, 500, 850].forEach(function (delay) {
      setTimeout(refreshFolderStateControls, delay);
    });
  }

  function inheritedFolderStates(path) {
    const folders = Model.stores(folderConfig, "flow").folders;
    let current = Model.normalisePath(path);
    while (current) {
      if (folders[current]) {
        return {
          hidden: !!folders[current].hidden,
          disabled: !!folders[current].disabled,
          locked: !!folders[current].locked,
        };
      }
      current = Model.parentPath(current);
    }
    return { hidden: false, disabled: false, locked: false };
  }

  function flowStatesForDestination(path, options) {
    const states = inheritedFolderStates(path);
    return {
      hidden: states.hidden,
      // A newly created flow should be usable immediately, even when its
      // destination folder currently applies a disabled aggregate state.
      disabled: options && options.forceEnabled ? false : states.disabled,
      locked: states.locked,
    };
  }

  function applyInheritedStatesToFlow(flow, path, options) {
    if (!flow) {
      return;
    }
    const states = flowStatesForDestination(path, options);
    stateUpdateUntil = Date.now() + 900;
    setFlowState(flow, "hidden", states.hidden);
    if (flow.type === "subflow") {
      return;
    }
    setFlowState(flow, "disabled", states.disabled);
    setFlowState(flow, "locked", states.locked);
  }

  function applyInheritedStatesToFolder(path, parentPath) {
    const states = inheritedFolderStates(parentPath);
    ["hidden", "disabled", "locked"].forEach(function (state) {
      setStoredFolderState(path, state, states[state]);
    });
    flowsInFolder(path, true).forEach(function (flow) {
      if (flow.type === "subflow") {
        setFlowState(flow, "hidden", states.hidden);
      } else {
        setFlowState(flow, "hidden", states.hidden);
        setFlowState(flow, "disabled", states.disabled);
        setFlowState(flow, "locked", states.locked);
      }
    });
  }

  function refreshFolderStateControls() {
    if (!native.tree) {
      return;
    }
    native.tree.find(".folders-native-folder-row").each(function () {
      const row = $(this);
      const path = Model.normalisePath(row.attr("data-folder-path") || "");
      const label = row.closest(".red-ui-treeList-label");
      ["hidden", "disabled", "locked"].forEach(function (state) {
        const active = folderAllActive(path, state);
        const button = row.find(
          '.folders-folder-state[data-folder-state="' + state + '"]',
        );
        const labels =
          state === "hidden"
            ? ["Hide all flows in folder", "Show all flows in folder"]
            : state === "disabled"
              ? ["Disable all flows in folder", "Enable all flows in folder"]
              : ["Lock all flows in folder", "Unlock all flows in folder"];
        button
          .toggleClass("folders-state-active", active)
          .attr("title", active ? labels[1] : labels[0])
          .attr("aria-label", active ? labels[1] : labels[0]);
      });
      label
        .toggleClass("folders-hidden", folderAllActive(path, "hidden"))
        .toggleClass("folders-disabled", folderAllActive(path, "disabled"))
        .toggleClass("folders-locked", folderAllActive(path, "locked"));
    });
    if (native.flowRoot) {
      collectNativeItems(native.flowRoot, "subflow").forEach(function (item) {
        const hidden = isHidden(findSubflow(item.id));
        const element = $(item.element);
        element.toggleClass("red-ui-info-outline-item-hidden", hidden);
        element
          .find(".folders-subflow-hide")
          .attr("title", hidden ? "Show subflow" : "Hide subflow")
          .attr("aria-label", hidden ? "Show subflow" : "Hide subflow");
      });
    }
  }

  function appendFolderStateButton(actions, path, state, icons, labels) {
    const active = folderAllActive(path, state);
    return $("<button>", {
      type: "button",
      class:
        "red-ui-button red-ui-button-small folders-folder-state" +
        (active ? " folders-state-active" : ""),
      "data-folder-state": state,
      title: active ? labels[1] : labels[0],
      "aria-label": active ? labels[1] : labels[0],
    })
      .append($("<i>", { class: icons[0] + " folders-icon-off" }))
      .append($("<i>", { class: icons[1] + " folders-icon-on" }))
      .appendTo(actions)
      .on("click" + EVENT_NAMESPACE, function (event) {
        event.preventDefault();
        event.stopPropagation();
        applyStateToSelection("folder:" + Model.normalisePath(path), state);
      });
  }

  function inlineRenameKeyAction(event) {
    const key = String((event && (event.key || event.code)) || "");
    const keyCode = event && (event.which || event.keyCode);
    if (key === "Enter" || key === "NumpadEnter" || keyCode === 13) {
      return "commit";
    }
    if (key === "Escape" || key === "Esc" || keyCode === 27) {
      return "cancel";
    }
    return null;
  }

  function bindInlineRenameKeyboard(input, finish) {
    const element = input && input[0];
    if (!element) {
      return;
    }
    const handler = function (event) {
      // Do not commit while an input method editor is composing text.
      if (event.isComposing) {
        return;
      }
      event.stopPropagation();
      event.stopImmediatePropagation();
      const action = inlineRenameKeyAction(event);
      if (action) {
        event.preventDefault();
        finish(action === "commit");
      }
    };
    // Keyup is a fallback for editor-level shortcuts that consume keydown.
    element.addEventListener("keydown", handler, true);
    element.addEventListener("keyup", handler, true);
  }

  function startInlineFolderRename(element, node) {
    if (element.find(".folders-inline-folder").length) {
      return;
    }
    const name = element.find(".folders-native-folder-name");
    const actions = element.find(".folders-folder-actions");
    const input = $("<input>", {
      type: "text",
      class: "folders-inline-folder",
      value: node.name,
    }).insertAfter(element.find(".folders-native-folder-icon"));
    name.hide();
    actions.hide();
    let finished = false;
    function finish(commit) {
      if (finished) {
        return;
      }
      finished = true;
      let displayName = node.name;
      if (commit) {
        const value = String(input.val() || "").trim();
        if (value && value.indexOf("/") === -1) {
          try {
            displayName = value;
            if (value !== node.name) {
              moveCombinedFolder(node.path, Model.parentPath(node.path), value);
              scheduleConfigSave(true);
              scheduleReconcile(0);
            }
          } catch (err) {
            notify(err.message, "error");
            displayName = node.name;
          }
        }
      }
      input.remove();
      name.show().text(displayName).attr("title", displayName);
      actions.show();
      pendingRename = null;
    }
    bindInlineRenameKeyboard(input, finish);
    input
      .on("click dblclick mousedown dragstart", function (event) {
        event.stopPropagation();
      })
      .on("blur", function () {
        finish(true);
      })
      .trigger("focus")
      .trigger("select");
  }

  function markNodeRenamed(node, kind, previousName) {
    if (!node) {
      return;
    }
    try {
      if (RED.history && typeof RED.history.push === "function") {
        RED.history.push({
          t: "edit",
          node: node,
          changes: { [kind === "flow" ? "label" : "name"]: previousName },
          dirty: RED.nodes.dirty(),
        });
      }
    } catch (err) {}
    node.changed = true;
    RED.nodes.dirty(true);
    structureUpdateUntil = Date.now() + 500;
    try {
      RED.events.emit(
        kind === "flow"
          ? "flows:change"
          : kind === "subflow"
            ? "subflows:change"
            : node.type === "group"
              ? "groups:change"
              : "nodes:change",
        node,
      );
    } catch (err) {}
    if (
      (kind === "flow" || kind === "subflow") &&
      RED.workspaces &&
      typeof RED.workspaces.refresh === "function"
    ) {
      RED.workspaces.refresh();
      setTimeout(sortCombinedTreeInPlace, 0);
    }
  }

  function startInlineItemRename(item, kind) {
    if (!item || !item.element) {
      return;
    }
    const node =
      kind === "node"
        ? RED.nodes.node(item.id) || RED.nodes.group(item.id)
        : nativeNode(kind, item.id);
    if (!node) {
      return;
    }
    const element = $(item.element);
    if (element.find(".folders-inline-item").length) {
      return;
    }
    const host = element
      .find(".red-ui-info-outline-item")
      .addBack(".red-ui-info-outline-item")
      .first();
    const label = element.find(".red-ui-info-outline-item-label").first();
    const controls = element.find(".red-ui-info-outline-item-controls").first();
    const property = kind === "flow" ? "label" : "name";
    const original = String(node[property] || itemLabel(node));
    const input = $("<input>", {
      type: "text",
      class: "folders-inline-folder folders-inline-item",
      value: original,
    });
    if (controls.length) {
      input.insertBefore(controls);
      controls.hide();
    } else if (host.length) {
      input.appendTo(host);
    } else {
      input.appendTo(element);
    }
    label.hide();
    let finished = false;
    function finish(commit) {
      if (finished) {
        return;
      }
      finished = true;
      const value = String(input.val() || "").trim();
      if (commit && value && value !== original) {
        if (kind === "flow") {
          node.label = value;
        } else {
          node.name = value;
          if (kind === "subflow") {
            node.label = value;
          }
        }
        const metaKind =
          kind === "subflow" ? "subflow" : kind === "flow" ? "flow" : null;
        if (metaKind) {
          const record = nativeItemMeta(metaKind, item.id);
          if (record) {
            record.name = value;
            record.updatedAt = new Date().toISOString();
            scheduleConfigSave(true);
          }
        }
        markNodeRenamed(node, kind, original);
      }
      input.remove();
      const displayName = commit && value ? value : original;
      label.show().text(displayName).attr("title", displayName);
      controls.show();
      pendingRename = null;
    }
    bindInlineRenameKeyboard(input, finish);
    input
      .on("click dblclick mousedown dragstart contextmenu", function (event) {
        event.stopPropagation();
      })
      .on("blur", function () {
        finish(true);
      })
      .trigger("focus")
      .trigger("select");
  }

  function makeFolderElement(kind, node) {
    const color = Model.normaliseColor(node.meta.color);
    const element = $("<div>", {
      class: "folders-native-folder-row",
      "data-folder-kind": kind,
      "data-folder-path": node.path,
    });
    if (color) {
      element
        .addClass("folders-native-has-color")
        .css("--folders-item-color", color);
    }
    $("<span>", { class: "folders-native-folder-icon" })
      .append(
        $("<i>", {
          class: Model.normaliseIcon(node.meta.icon, Model.DEFAULT_FOLDER_ICON),
        }),
      )
      .appendTo(element);
    $("<span>", {
      class: "folders-native-folder-name",
      text: node.name,
    }).appendTo(element);
    const actions = $("<div>", {
      class:
        "red-ui-info-outline-item-controls " +
        "red-ui-info-outline-item-hover-controls folders-folder-actions",
    }).appendTo(element);
    appendFolderStateButton(
      actions,
      node.path,
      "hidden",
      ["fa fa-eye", "fa fa-eye-slash"],
      ["Hide all flows in folder", "Show all flows in folder"],
    );
    appendFolderStateButton(
      actions,
      node.path,
      "disabled",
      ["fa fa-circle-thin", "fa fa-ban"],
      ["Disable all flows in folder", "Enable all flows in folder"],
    );
    appendFolderStateButton(
      actions,
      node.path,
      "locked",
      ["fa fa-unlock-alt", "fa fa-lock"],
      ["Lock all flows in folder", "Unlock all flows in folder"],
    );
    $("<button>", {
      type: "button",
      class: "red-ui-button red-ui-button-small",
      "aria-label": "Rename",
      title: "Rename",
    })
      .append($("<i>", { class: "fa fa-pencil" }))
      .appendTo(actions)
      .on("click" + EVENT_NAMESPACE, function (event) {
        event.preventDefault();
        event.stopPropagation();
        startInlineFolderRename(element, node);
      });
    return element;
  }

  function makeFolderTreeItem(kind, node) {
    const item = {
      id: Model.makeFolderId(kind, node.path),
      __foldersFolder: true,
      folderKind: kind,
      folderPath: node.path,
      element: makeFolderElement(kind, node),
      expandOnClick: false,
      expanded: false,
      __foldersExpanded: !collapsedFolders.has(folderStateKey(kind, node.path)),
      children: [],
    };
    node.folders.forEach(function (child) {
      item.children.push(makeFolderTreeItem(kind, child));
    });
    node.items.forEach(function (child) {
      item.children.push(child);
    });
    return item;
  }

  function removeStaleEmptyItems(root, hasItems) {
    if (!hasItems) {
      return;
    }
    (root.children || []).slice().forEach(function (child) {
      if (child && child.empty) {
        removeTreeItem(child, false);
      }
    });
  }

  function compareFolderNodes(left, right) {
    const field =
      sortMode === "created"
        ? "createdAt"
        : sortMode === "updated"
          ? "updatedAt"
          : "name";
    const leftValue =
      sortMode === "type" ? "folder" : String(left.meta[field] || left.name);
    const rightValue =
      sortMode === "type" ? "folder" : String(right.meta[field] || right.name);
    let result = leftValue.localeCompare(rightValue, undefined, {
      sensitivity: "base",
    });
    if (!result) {
      result = left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
      });
    }
    return sortDirection === "desc" ? -result : result;
  }

  function itemKind(item) {
    if (!item || !item.id) {
      return null;
    }
    return findWorkspace(item.id)
      ? "flow"
      : findSubflow(item.id)
        ? "subflow"
        : null;
  }

  function selectionKeyForItem(item) {
    if (!item) {
      return null;
    }
    if (item.__foldersFolder) {
      return "folder:" + Model.normalisePath(item.folderPath);
    }
    const kind = itemKind(item);
    return kind ? kind + ":" + item.id : null;
  }

  function combinedSelectableItems() {
    const items = [];
    function visit(item) {
      const key = selectionKeyForItem(item);
      if (key) {
        items.push(item);
      }
      if (item && item.__foldersFolder) {
        (item.children || []).forEach(visit);
      }
    }
    (native.flowRoot && native.flowRoot.children
      ? native.flowRoot.children
      : []
    ).forEach(visit);
    return items;
  }

  function visibleSelectableItems() {
    return combinedSelectableItems().filter(function (item) {
      if (!item.treeList || !item.treeList.container) {
        return true;
      }
      const listItem = item.treeList.container.closest("li");
      return !listItem.length || listItem.is(":visible");
    });
  }

  function selectionRangeKeys(keys, anchorKey, targetKey) {
    const start = keys.indexOf(anchorKey);
    const end = keys.indexOf(targetKey);
    if (start === -1 || end === -1) {
      return [];
    }
    return keys.slice(Math.min(start, end), Math.max(start, end) + 1);
  }

  function itemForSelectionKey(key) {
    return combinedSelectableItems().find(function (item) {
      return selectionKeyForItem(item) === key;
    });
  }

  function selectionEntry(key) {
    const value = String(key || "");
    const separator = value.indexOf(":");
    if (separator === -1) {
      return null;
    }
    const type = value.slice(0, separator);
    const id = value.slice(separator + 1);
    if (!id || !["folder", "flow", "subflow"].includes(type)) {
      return null;
    }
    return { type: type, id: id };
  }

  function applySelectionToTree() {
    if (!native.tree) {
      return;
    }
    const items = combinedSelectableItems();
    const available = new Set(items.map(selectionKeyForItem));
    Array.from(selectedKeys).forEach(function (key) {
      if (!available.has(key)) {
        selectedKeys.delete(key);
      }
    });
    if (primarySelectionKey && !selectedKeys.has(primarySelectionKey)) {
      primarySelectionKey = selectedKeys.values().next().value || null;
    }
    try {
      native.tree.treeList("clearSelection");
      const selectedItems = items.filter(function (item) {
        return selectedKeys.has(selectionKeyForItem(item));
      });
      if (selectedItems.length) {
        native.tree.treeList("select", selectedItems, false);
      }
    } catch (err) {
      native.tree
        .find(".red-ui-treeList-label.selected")
        .removeClass("selected");
    }
    // Keep a plugin-owned selection marker as Node-RED's TreeList may reduce
    // a mixed custom/native selection to its single focused row.
    items.forEach(function (item) {
      if (item.treeList && item.treeList.label) {
        const selected = selectedKeys.has(selectionKeyForItem(item));
        item.treeList.label
          .toggleClass("selected", selected)
          .toggleClass("folders-multi-selected", selected);
      }
    });
  }

  function dragDescriptorForItem(item) {
    if (!item) {
      return null;
    }
    if (item.__foldersFolder) {
      return {
        type: "folder",
        kind: "flow",
        path: Model.normalisePath(item.folderPath),
      };
    }
    const kind = itemKind(item);
    return kind ? { type: "item", kind: kind, id: item.id } : null;
  }

  function dragPayloadForItem(item) {
    const key = selectionKeyForItem(item);
    const descriptors =
      key && selectedKeys.has(key) && selectedKeys.size > 1
        ? Array.from(selectedKeys)
            .map(itemForSelectionKey)
            .map(dragDescriptorForItem)
            .filter(Boolean)
        : [dragDescriptorForItem(item)].filter(Boolean);
    return { plugin: PLUGIN_ID, type: "selection", items: descriptors };
  }

  function compareNativeItems(left, right) {
    const leftKind = itemKind(left) || "flow";
    const rightKind = itemKind(right) || "flow";
    const leftMeta = nativeItemMeta(leftKind, left.id) || {};
    const rightMeta = nativeItemMeta(rightKind, right.id) || {};
    const leftNode = nativeNode(leftKind, left.id);
    const rightNode = nativeNode(rightKind, right.id);
    let leftValue;
    let rightValue;
    if (sortMode === "created" || sortMode === "updated") {
      const field = sortMode + "At";
      leftValue = String(leftMeta[field] || "");
      rightValue = String(rightMeta[field] || "");
    } else if (sortMode === "type") {
      leftValue = String((leftNode && leftNode.type) || leftKind);
      rightValue = String((rightNode && rightNode.type) || rightKind);
    } else {
      leftValue = itemLabel(leftNode);
      rightValue = itemLabel(rightNode);
    }
    let result = leftValue.localeCompare(rightValue, undefined, {
      sensitivity: "base",
    });
    if (!result) {
      result = itemLabel(leftNode).localeCompare(
        itemLabel(rightNode),
        undefined,
        {
          sensitivity: "base",
        },
      );
    }
    return sortDirection === "desc" ? -result : result;
  }

  function sortFolderModel(model) {
    function sortFolder(folder) {
      folder.folders.sort(compareFolderNodes);
      folder.items.sort(compareNativeItems);
      folder.folders.forEach(sortFolder);
    }
    model.folders.sort(compareFolderNodes);
    model.rootItems.sort(compareNativeItems);
    model.folders.forEach(sortFolder);
    return model;
  }

  function sortCombinedTreeInPlace() {
    if (!native.flowRoot || !native.flowRoot.treeList) {
      return;
    }
    function compare(left, right) {
      if (left.__foldersFolder && right.__foldersFolder) {
        const leftRecord =
          Model.stores(folderConfig, "flow").folders[left.folderPath] || {};
        const rightRecord =
          Model.stores(folderConfig, "flow").folders[right.folderPath] || {};
        return compareFolderNodes(
          {
            name: leftRecord.name || Model.baseName(left.folderPath),
            meta: leftRecord,
          },
          {
            name: rightRecord.name || Model.baseName(right.folderPath),
            meta: rightRecord,
          },
        );
      }
      if (left.__foldersFolder !== right.__foldersFolder) {
        return left.__foldersFolder ? -1 : 1;
      }
      return compareNativeItems(left, right);
    }
    function sortParent(parent) {
      if (
        parent.treeList &&
        typeof parent.treeList.sortChildren === "function"
      ) {
        parent.treeList.sortChildren(compare);
      }
      (parent.children || []).forEach(function (child) {
        if (child.__foldersFolder) {
          sortParent(child);
        }
      });
    }
    sortParent(native.flowRoot);
    applyWorkspaceFilter();
  }

  function buildCombinedFolderTree(flowItems, subflowItems) {
    const flowStore = Model.stores(folderConfig, "flow");
    const subflowStore = Model.stores(folderConfig, "subflow");
    const nodes = {};
    Object.keys(flowStore.folders).forEach(function (path) {
      const meta = flowStore.folders[path];
      nodes[path] = {
        path: path,
        name: meta.name || Model.baseName(path),
        meta: meta,
        folders: [],
        items: [],
      };
    });
    const roots = [];
    Object.keys(nodes).forEach(function (path) {
      const parent = Model.parentPath(path);
      if (parent && nodes[parent]) {
        nodes[parent].folders.push(nodes[path]);
      } else {
        roots.push(nodes[path]);
      }
    });
    const rootItems = [];
    function place(items, kind, store) {
      items.forEach(function (item) {
        const path =
          item && item.id && store.items[item.id]
            ? Model.normalisePath(store.items[item.id].path)
            : "";
        if (path && nodes[path]) {
          nodes[path].items.push(item);
        } else {
          rootItems.push(item);
        }
      });
    }
    place(flowItems, "flow", flowStore);
    place(subflowItems, "subflow", subflowStore);
    return sortFolderModel({ folders: roots, rootItems: rootItems });
  }

  function collectUniqueItems(roots, kind) {
    const result = [];
    const seen = new Set();
    roots.forEach(function (root) {
      collectNativeItems(root, kind).forEach(function (item) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          result.push(item);
        }
      });
    });
    return result;
  }

  function desiredExpansionState(item) {
    if (desiredExpansionStates.has(item)) {
      return desiredExpansionStates.get(item);
    }
    return !!(
      item &&
      item.treeList &&
      item.treeList.container &&
      item.treeList.container.hasClass("expanded")
    );
  }

  function nextExpansionState(item) {
    return !desiredExpansionState(item);
  }

  function applyExpansionVisual(item, expanded, animated) {
    if (!item || !item.treeList) {
      return false;
    }
    const childList = item.treeList.childList;
    item.expanded = !!expanded;
    if (item.treeList.container) {
      item.treeList.container.toggleClass("expanded", !!expanded);
    }
    if (!childList) {
      return false;
    }
    childList.stop(true, false);
    if (animated) {
      childList[expanded ? "slideDown" : "slideUp"]("fast");
    } else {
      childList.toggle(!!expanded);
    }
    return true;
  }

  // Deferred native children can finish their own delayed slide after a user
  // has already reversed direction. These checks keep the latest click final.
  function monitorDeferredExpansion(item) {
    if (!item || deferredExpansionTimers.has(item)) {
      return;
    }
    let childListSeen = false;
    const timers = new Set();
    [0, 25, 75, 150, 250, 420, 500].forEach(function (delay) {
      const timer = setTimeout(function () {
        timers.delete(timer);
        if (!started || !item.treeList) {
          if (!timers.size) {
            deferredExpansionTimers.delete(item);
          }
          return;
        }
        const hasChildList = !!item.treeList.childList;
        if (hasChildList && !childListSeen) {
          childListSeen = true;
          applyExpansionVisual(item, desiredExpansionState(item), true);
        }
        if (hasChildList && delay >= 420) {
          applyExpansionVisual(item, desiredExpansionState(item), false);
        }
        if (!timers.size) {
          deferredExpansionTimers.delete(item);
        }
      }, delay);
      timers.add(timer);
    });
    deferredExpansionTimers.set(item, timers);
  }

  // Rebuilds restore their final state without replaying visible animations.
  function setItemExpandedInstant(item, expanded) {
    if (!item || !item.treeList || !item.children) {
      return;
    }
    desiredExpansionStates.set(item, !!expanded);
    if (
      expanded &&
      !item.treeList.childList &&
      typeof item.treeList.expand === "function"
    ) {
      item.treeList.expand(function () {
        setTimeout(function () {
          if (item.treeList) {
            setItemExpandedInstant(item, desiredExpansionState(item));
          }
        }, 0);
      });
      monitorDeferredExpansion(item);
      return;
    }
    applyExpansionVisual(item, expanded, false);
  }

  function setItemExpandedAnimated(item, expanded) {
    if (!item || !item.treeList || !item.children) {
      return;
    }
    desiredExpansionStates.set(item, !!expanded);
    if (applyExpansionVisual(item, expanded, true)) {
      return;
    }
    if (expanded && typeof item.treeList.expand === "function") {
      item.treeList.expand();
      applyExpansionVisual(item, desiredExpansionState(item), true);
    } else {
      item.expanded = false;
      if (item.treeList.container) {
        item.treeList.container.removeClass("expanded");
      }
    }
    monitorDeferredExpansion(item);
  }

  function restoreExpansionInstant(item, expandedNativeKeys) {
    if (!item) {
      return;
    }
    if (item.__foldersFolder) {
      setItemExpandedInstant(item, !!item.__foldersExpanded);
      (item.children || []).forEach(function (child) {
        restoreExpansionInstant(child, expandedNativeKeys);
      });
      return;
    }
    const kind = itemKind(item);
    if (kind) {
      setItemExpandedInstant(
        item,
        expandedNativeKeys.has(kind + ":" + item.id),
      );
    }
  }

  function regroupCombinedRoot() {
    const roots = [native.flowRoot, native.subflowRoot];
    const flowItems = collectUniqueItems(roots, "flow");
    const subflowItems = collectUniqueItems(roots, "subflow");
    const actualItems = flowItems.concat(subflowItems);
    const expandedNativeKeys = new Set();
    actualItems.forEach(function (item) {
      if (
        item.treeList &&
        item.treeList.container &&
        item.treeList.container.hasClass("expanded")
      ) {
        expandedNativeKeys.add(itemKind(item) + ":" + item.id);
      }
      item.expanded = false;
    });
    const hasCombinedContent =
      actualItems.length > 0 ||
      Object.keys(Model.stores(folderConfig, "flow").folders).length > 0;
    actualItems.forEach(function (item) {
      removeTreeItem(item, true);
    });
    roots.forEach(function (root, index) {
      (root.children || []).slice().forEach(function (item) {
        if (item && item.__foldersFolder) {
          removePluginFolder(item);
        }
      });
      removeStaleEmptyItems(
        root,
        index === 0 ? hasCombinedContent : subflowItems.length > 0,
      );
    });
    const model = buildCombinedFolderTree(flowItems, subflowItems);
    model.folders.forEach(function (folder) {
      native.flowRoot.treeList.addChild(makeFolderTreeItem("flow", folder));
    });
    model.rootItems.forEach(function (item) {
      native.flowRoot.treeList.addChild(item);
    });
    (native.flowRoot.children || []).forEach(function (item) {
      normaliseVisibleIndent(item, 1);
      restoreExpansionInstant(item, expandedNativeKeys);
    });
    setItemExpandedInstant(native.flowRoot, true);
    applySelectionToTree();
  }

  function nativeItemMeta(kind, id) {
    return Model.stores(folderConfig, kind).items[id] || null;
  }

  function isCustomFlowIcon(icon) {
    return !!icon && icon !== DEFAULT_FLOW_ICON;
  }

  function styleNativeItem(item, kind) {
    if (!item || !item.treeList || !item.treeList.label) {
      return;
    }
    const label = item.treeList.label;
    const meta = nativeItemMeta(kind, item.id) || {};
    const icon = Model.normaliseIcon(meta.icon, "");
    const color = Model.normaliseColor(meta.color);
    label
      .removeClass("folders-native-item folders-native-has-color")
      .addClass("folders-native-item")
      .css("--folders-item-color", "");
    if (color) {
      label
        .addClass("folders-native-has-color")
        .css("--folders-item-color", color);
    }
    if (kind === "flow") {
      const iconElement = label
        .children(".red-ui-treeList-icon")
        .eq(1)
        .find("i")
        .first();
      if (iconElement.length) {
        if (!iconElement.data("folders-original-class")) {
          iconElement.data(
            "folders-original-class",
            iconElement.attr("class") || "",
          );
        }
        iconElement.attr(
          "class",
          icon || iconElement.data("folders-original-class"),
        );
        iconElement.toggleClass(
          "folders-native-custom-flow-icon",
          isCustomFlowIcon(icon),
        );
      }
    } else if (item.element) {
      const element = $(item.element);
      element.find(".folders-native-custom-icon").remove();
      element
        .find(".red-ui-node-icon-container")
        .toggleClass("folders-native-icon-hidden", !!icon);
      if (icon) {
        $("<span>", {
          class: "red-ui-treeList-icon folders-native-custom-icon",
        })
          .append($("<i>", { class: icon }))
          .prependTo(element);
      }
    }
  }

  function styleFolderItem(item) {
    if (!item || !item.__foldersFolder || !item.element) {
      return;
    }
    const record =
      Model.stores(folderConfig, item.folderKind).folders[item.folderPath] ||
      {};
    const color = Model.normaliseColor(record.color);
    const element = $(item.element);
    element
      .toggleClass("folders-native-has-color", !!color)
      .css("--folders-item-color", color || "");
    element
      .find(".folders-native-folder-icon i")
      .first()
      .attr(
        "class",
        Model.normaliseIcon(record.icon, Model.DEFAULT_FOLDER_ICON),
      );
  }

  // Restore every native element before handing the Explorer back to Node-RED.
  function restoreNativeItem(item, kind) {
    if (!item) {
      return;
    }
    if (item.treeList && item.treeList.label) {
      const label = item.treeList.label;
      label
        .off(EVENT_NAMESPACE)
        .removeAttr("draggable")
        .removeClass(
          "folders-native-item folders-native-has-color folders-native-drop-target",
        )
        .css("--folders-item-color", "");
      if (kind === "flow") {
        const iconElement = label
          .children(".red-ui-treeList-icon")
          .eq(1)
          .find("i")
          .first();
        const originalClass = iconElement.data("folders-original-class");
        if (originalClass !== undefined) {
          iconElement
            .attr("class", originalClass)
            .removeData("folders-original-class");
        }
        iconElement.removeClass("folders-native-custom-flow-icon");
      }
    }
    if (kind === "subflow" && item.element) {
      const element = $(item.element);
      element.find(".folders-native-custom-icon").remove();
      element.find(".folders-subflow-hide").remove();
      element.removeClass("red-ui-info-outline-item-hidden");
      element
        .find(".red-ui-node-icon-container")
        .removeClass("folders-native-icon-hidden");
    }
    if (item.element) {
      $(item.element)
        .find("button")
        .each(function () {
          const handler = $(this).data("folders-state-capture");
          if (handler) {
            this.removeEventListener("click", handler, true);
            $(this).removeData("folders-state-capture");
          }
        });
    }
  }

  function setDragData(event, data) {
    const original = event.originalEvent;
    if (original && original.dataTransfer) {
      original.dataTransfer.effectAllowed = "move";
      original.dataTransfer.setData("text/plain", JSON.stringify(data));
    }
  }

  function getDragData(event) {
    const original = event.originalEvent;
    if (!original || !original.dataTransfer) {
      return null;
    }
    try {
      return JSON.parse(original.dataTransfer.getData("text/plain"));
    } catch (err) {
      return null;
    }
  }

  function applyDrop(data, targetKind, targetPath) {
    const cleanTargetPath = Model.normalisePath(targetPath);
    if (!data || data.plugin !== PLUGIN_ID) {
      notify("That dragged item does not belong to Folders.", "warning");
      return;
    }
    if (targetKind !== "flow") {
      notify("That destination is not part of the workspace.", "warning");
      return;
    }
    const rawItems =
      data.type === "selection" && Array.isArray(data.items)
        ? data.items
        : [data];
    const items = rawItems.filter(function (item) {
      return (
        item &&
        (item.type === "folder" || item.type === "item") &&
        (item.kind === "flow" || item.kind === "subflow")
      );
    });
    if (!items.length) {
      notify("There is nothing to move.", "warning");
      return;
    }
    const selectedFolderPaths = items
      .filter(function (item) {
        return item.type === "folder";
      })
      .map(function (item) {
        return Model.normalisePath(item.path);
      })
      .filter(Boolean);
    const compactItems = items.filter(function (item) {
      if (item.type === "folder") {
        const path = Model.normalisePath(item.path);
        return !selectedFolderPaths.some(function (otherPath) {
          return otherPath !== path && path.indexOf(otherPath + "/") === 0;
        });
      }
      const meta = nativeItemMeta(item.kind, item.id) || {};
      const path = Model.normalisePath(meta.path);
      return !selectedFolderPaths.some(function (folderPath) {
        return path === folderPath || path.indexOf(folderPath + "/") === 0;
      });
    });
    try {
      compactItems.forEach(function (item) {
        if (item.type === "folder") {
          const sourcePath = Model.normalisePath(item.path);
          const targetStore = Model.stores(folderConfig, "flow");
          if (!sourcePath || !targetStore.folders[sourcePath]) {
            throw new Error("A selected folder no longer exists.");
          }
          const newPath = moveCombinedFolder(
            sourcePath,
            cleanTargetPath,
            Model.baseName(sourcePath),
          );
          applyInheritedStatesToFolder(newPath, cleanTargetPath);
          const oldKey = "folder:" + sourcePath;
          const newKey = "folder:" + newPath;
          if (selectedKeys.delete(oldKey)) {
            selectedKeys.add(newKey);
          }
          if (primarySelectionKey === oldKey) {
            primarySelectionKey = newKey;
          }
          return;
        }
        const targetStore = Model.stores(folderConfig, item.kind);
        if (cleanTargetPath && !targetStore.folders[cleanTargetPath]) {
          const canonical = Model.stores(folderConfig, "flow").folders[
            cleanTargetPath
          ];
          if (!canonical) {
            throw new Error("That destination folder no longer exists.");
          }
          Model.ensureFolder(
            folderConfig,
            item.kind,
            cleanTargetPath,
            canonical,
          );
        }
        const itemId = String(item.id || "");
        const node = itemId && nativeNode(item.kind, itemId);
        if (!node) {
          throw new Error("A selected flow or subflow no longer exists.");
        }
        Model.setItemPath(
          folderConfig,
          item.kind,
          itemId,
          cleanTargetPath,
          itemLabel(node),
        );
        applyInheritedStatesToFlow(node, cleanTargetPath);
      });
      scheduleConfigSave(true);
      scheduleReconcile(0);
    } catch (err) {
      notify(err.message, "error");
    }
  }

  function bindDropTarget(label, kind, path) {
    label
      .off(
        "dragover" +
          EVENT_NAMESPACE +
          " dragleave" +
          EVENT_NAMESPACE +
          " drop" +
          EVENT_NAMESPACE,
      )
      .on("dragover" + EVENT_NAMESPACE, function (event) {
        event.preventDefault();
        $(this).addClass("folders-native-drop-target");
      })
      .on("dragleave" + EVENT_NAMESPACE, function () {
        $(this).removeClass("folders-native-drop-target");
      })
      .on("drop" + EVENT_NAMESPACE, function (event) {
        event.preventDefault();
        event.stopPropagation();
        $(this).removeClass("folders-native-drop-target");
        applyDrop(getDragData(event), kind, path);
      });
  }

  function folderItemCount(kind, path) {
    const cleanPath = Model.normalisePath(path);
    return ["flow", "subflow"].reduce(function (total, itemKindValue) {
      const items = Model.stores(folderConfig, itemKindValue).items;
      return (
        total +
        Object.keys(items).filter(function (id) {
          const itemPath = Model.normalisePath(items[id].path);
          return (
            itemPath === cleanPath || itemPath.indexOf(cleanPath + "/") === 0
          );
        }).length
      );
    }, 0);
  }

  function renderFolderInfo(kind, path) {
    const cleanPath = Model.normalisePath(path);
    const record = Model.stores(folderConfig, kind).folders[cleanPath] || {};
    const details = [
      ["Directory", "/" + cleanPath],
      ["Items", folderItemCount(kind, cleanPath)],
      ["Created", record.createdAt || ""],
      ["Updated", record.updatedAt || ""],
      ["Icon", record.icon || Model.DEFAULT_FOLDER_ICON],
      ["Colour", record.color || "Default"],
    ];

    $(".folders-native-info-panel").remove();
    const panel = $(".red-ui-sidebar-info").first();
    if (!panel.length) {
      return;
    }
    const info = $("<div>", { class: "folders-native-info-panel" });
    details.forEach(function (detail) {
      $("<div>", {
        class: "folders-native-info-label",
        text: detail[0],
      }).appendTo(info);
      $("<div>", {
        class: "folders-native-info-value",
        text: detail[1],
      }).appendTo(info);
    });
    panel.append(info);
  }

  function showFolderInfo(kind, path) {
    const cleanPath = Model.normalisePath(path);
    const record = Model.stores(folderConfig, kind).folders[cleanPath] || {};
    const label = record.name || Model.baseName(cleanPath) || "Folder";
    try {
      RED.sidebar.info.refresh({
        id: "folders-folder:" + kind + ":" + cleanPath,
        type: "folders-folder",
        label: label,
        name: label,
        icon: record.icon || Model.DEFAULT_FOLDER_ICON,
        color: record.color || "",
        info:
          "Folder information is stored in the global `" +
          GLOBAL_ENV_NAME +
          "` environment variable.",
      });
    } catch (err) {}
    [20, 80, 180].forEach(function (delay) {
      setTimeout(function () {
        renderFolderInfo(kind, cleanPath);
      }, delay);
    });
  }

  function bindFolderItem(item) {
    if (!item.treeList || !item.treeList.label) {
      return;
    }
    const label = item.treeList.label;
    label
      .attr("draggable", "true")
      .off(EVENT_NAMESPACE)
      .on("dragstart" + EVENT_NAMESPACE, function (event) {
        setDragData(event, dragPayloadForItem(item));
      })
      .on("contextmenu" + EVENT_NAMESPACE, function (event) {
        event.preventDefault();
        event.stopPropagation();
        selectForContextMenu(item);
        openFolderMenu(event, item.folderKind, item.folderPath);
      })
      .on("click" + EVENT_NAMESPACE, function () {
        showFolderInfo(item.folderKind, item.folderPath);
        setTimeout(function () {
          if (!item.treeList || !item.treeList.container) {
            return;
          }
          const key = folderStateKey(item.folderKind, item.folderPath);
          if (item.treeList.container.hasClass("expanded")) {
            collapsedFolders.delete(key);
          } else {
            collapsedFolders.add(key);
          }
          saveLocalState();
        }, 0);
      });
    bindDropTarget(label, item.folderKind, item.folderPath);
    (item.children || []).forEach(function (child) {
      if (child.__foldersFolder) {
        bindFolderItem(child);
      }
    });
  }

  function bindNativeStateButtons(item, kind) {
    if (!item || !item.element) {
      return;
    }
    const key = kind + ":" + item.id;
    if (kind === "subflow") {
      const element = $(item.element);
      const controls = element
        .find(".red-ui-info-outline-item-controls")
        .first();
      if (controls.length && !controls.find(".folders-subflow-hide").length) {
        $("<button>", {
          type: "button",
          class:
            "red-ui-info-outline-item-control-hide red-ui-button " +
            "red-ui-button-small folders-subflow-hide",
          title: "Hide subflow",
          "aria-label": "Hide subflow",
        })
          .append($("<i>", { class: "fa fa-eye" }))
          .append($("<i>", { class: "fa fa-eye-slash" }))
          .prependTo(controls);
      }
      element.toggleClass(
        "red-ui-info-outline-item-hidden",
        isHidden(findSubflow(item.id)),
      );
    }
    [
      ["hidden", ".red-ui-info-outline-item-control-hide"],
      ["disabled", ".red-ui-info-outline-item-control-disable"],
      ["locked", ".red-ui-info-outline-item-control-lock"],
    ].forEach(function (definition) {
      const state = definition[0];
      if (kind === "subflow" && state !== "hidden") {
        return;
      }
      $(item.element)
        .find(definition[1])
        .each(function () {
          const button = this;
          const previous = $(button).data("folders-state-capture");
          if (previous) {
            button.removeEventListener("click", previous, true);
          }
          const handler = function (event) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (!selectedKeys.has(key)) {
              selectTreeItem(item);
            }
            applyStateToSelection(key, state);
          };
          $(button).data("folders-state-capture", handler);
          button.addEventListener("click", handler, true);
        });
    });
  }

  function bindNativeItem(item, kind) {
    if (!item.treeList || !item.treeList.label) {
      return;
    }
    const label = item.treeList.label;
    label
      .attr("draggable", "true")
      .off(EVENT_NAMESPACE)
      .on("dragstart" + EVENT_NAMESPACE, function (event) {
        setDragData(event, dragPayloadForItem(item));
      })
      .on("contextmenu" + EVENT_NAMESPACE, function (event) {
        if (kind !== "flow") {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        selectForContextMenu(item);
        openItemMenu(event, item, kind);
      })
      .on("click" + EVENT_NAMESPACE, function () {
        $(".folders-native-info-panel").remove();
      });
    styleNativeItem(item, kind);
    bindNativeStateButtons(item, kind);
  }

  function createdTreeItem(request) {
    if (!request) {
      return null;
    }
    const key =
      request.type === "folder"
        ? "folder:" + Model.normalisePath(request.path)
        : request.type === "item" && request.kind && request.id
          ? request.kind + ":" + request.id
          : null;
    return key ? itemForSelectionKey(key) : null;
  }

  function expandCreatedItemParents(request) {
    const parentPath =
      request.type === "folder"
        ? Model.parentPath(request.path)
        : Model.normalisePath(
            request.path ||
              (nativeItemMeta(request.kind, request.id) || {}).path ||
              "",
          );
    let current = "";
    let changed = false;
    parentPath.split("/").forEach(function (part) {
      if (!part) {
        return;
      }
      current = Model.normalisePath((current ? current + "/" : "") + part);
      const folderItem = itemForSelectionKey("folder:" + current);
      if (folderItem && !desiredExpansionState(folderItem)) {
        setItemExpandedInstant(folderItem, true);
        collapsedFolders.delete(folderStateKey("flow", current));
        changed = true;
      }
    });
    if (changed) {
      saveLocalState();
    }
  }

  function verticalRevealScrollTop(metrics, forceCenter) {
    function metric(value, fallback) {
      const result = Number(value);
      return Number.isFinite(result) ? result : fallback;
    }
    const viewportTop = metric(metrics.viewportTop, 0);
    const viewportBottom = metric(metrics.viewportBottom, viewportTop);
    const itemTop = metric(metrics.itemTop, viewportTop);
    const itemBottom = metric(metrics.itemBottom, itemTop);
    if (
      !forceCenter &&
      itemTop >= viewportTop &&
      itemBottom <= viewportBottom
    ) {
      return null;
    }
    const viewportHeight = Math.max(
      0,
      metric(metrics.clientHeight, viewportBottom - viewportTop),
    );
    const currentTop = Math.max(0, metric(metrics.scrollTop, 0));
    const scrollHeight = Math.max(
      viewportHeight,
      metric(metrics.scrollHeight, viewportHeight),
    );
    const itemHeight = Math.max(0, itemBottom - itemTop);
    const itemCenter =
      currentTop + (itemTop - viewportTop) + itemHeight / 2;
    const requestedTop = itemCenter - viewportHeight / 2;
    return Math.max(
      0,
      Math.min(Math.max(0, scrollHeight - viewportHeight), requestedTop),
    );
  }

  function createdItemScrollTop(item, forceCenter) {
    if (!item || !item.treeList || !item.treeList.label) {
      return null;
    }
    const container = explorerScrollContainer();
    const element = item.treeList.label[0];
    if (!container.length || !element || !element.getBoundingClientRect) {
      return null;
    }
    const containerElement = container[0];
    const viewport = containerElement.getBoundingClientRect();
    const row = element.getBoundingClientRect();
    return verticalRevealScrollTop(
      {
        viewportTop: viewport.top,
        viewportBottom: viewport.bottom,
        itemTop: row.top,
        itemBottom: row.bottom,
        scrollTop: container.scrollTop(),
        scrollHeight: containerElement.scrollHeight,
        clientHeight: containerElement.clientHeight || viewport.height,
      },
      forceCenter,
    );
  }

  function prepareCreatedItemReveal(request, item) {
    if (!request || request.revealChecked) {
      return;
    }
    request.revealChecked = true;
    expandCreatedItemParents(request);
    const label = item && item.treeList && item.treeList.label;
    const needsReveal =
      !label ||
      !label.is(":visible") ||
      createdItemScrollTop(item, false) !== null;
    if (!needsReveal) {
      return;
    }
    // Reconciliation restores the previous viewport for 40 ms. Centre the
    // created row just after that restoration has settled.
    function revealWhenReady(attempt) {
      const liveItem = createdTreeItem(request);
      const liveLabel = liveItem && liveItem.treeList && liveItem.treeList.label;
      if (!liveLabel || !liveLabel.is(":visible")) {
        if (attempt < 3) {
          setTimeout(function () {
            revealWhenReady(attempt + 1);
          }, 100 + attempt * 80);
        }
        return;
      }
      const targetTop = createdItemScrollTop(liveItem, true);
      if (targetTop === null) {
        return;
      }
      const container = explorerScrollContainer();
      if (!container.length) {
        return;
      }
      lastExplorerViewport = {
        top: targetTop,
        left: container.scrollLeft(),
      };
      if (Math.abs(container.scrollTop() - targetTop) < 1) {
        return;
      }
      container.stop(true, false).animate({ scrollTop: targetTop }, 160);
    }
    setTimeout(function () {
      revealWhenReady(0);
    }, 70);
  }

  function decorateCombinedRoot() {
    (native.flowRoot.children || []).forEach(function (item) {
      if (item.__foldersFolder) {
        bindFolderItem(item);
      }
    });
    collectNativeItems(native.flowRoot, "flow").forEach(function (item) {
      bindNativeItem(item, "flow");
    });
    collectNativeItems(native.flowRoot, "subflow").forEach(function (item) {
      bindNativeItem(item, "subflow");
    });
    if (native.flowRoot.treeList && native.flowRoot.treeList.container) {
      bindDropTarget(native.flowRoot.treeList.container, "flow", "");
    }
    if (pendingRename) {
      const request = pendingRename;
      setTimeout(function () {
        if (!pendingRename || pendingRename !== request) {
          return;
        }
        if (request.type === "folder") {
          const row = native.tree
            .find(".folders-native-folder-row")
            .filter(function () {
              return (
                Model.normalisePath($(this).attr("data-folder-path") || "") ===
                request.path
              );
            })
            .first();
          if (row.length) {
            const item = row
              .closest(".red-ui-editableList-item-content")
              .data("data");
            if (item && item.element) {
              prepareCreatedItemReveal(request, item);
              startInlineFolderRename($(item.element), {
                path: item.folderPath,
                name: Model.baseName(item.folderPath),
              });
            }
          }
        } else if (request.type === "item") {
          const item = collectNativeItems(native.flowRoot, request.kind).find(
            function (candidate) {
              return candidate.id === request.id;
            },
          );
          if (item) {
            prepareCreatedItemReveal(request, item);
            startInlineItemRename(item, request.kind);
          }
        }
      }, 0);
    }
    refreshFolderStateControls();
  }

  function reconcileNativeTree() {
    reconcileTimer = null;
    if (
      native.tree &&
      native.tree.find(".folders-inline-folder:focus").length
    ) {
      scheduleReconcile(120);
      return;
    }
    if (
      !started ||
      reconciling ||
      !native.tree ||
      !native.tree.length ||
      !$.contains(document, native.tree[0])
    ) {
      return;
    }
    if (!refreshNativeRoots()) {
      scheduleAttach(100);
      return;
    }
    const viewport = pendingExplorerViewport || captureExplorerViewport();
    pendingExplorerViewport = null;
    reconciling = true;
    try {
      const changed = syncKnownItems();
      regroupCombinedRoot();
      restoreExplorerViewport(viewport);
      if (decorateTimer) {
        clearTimeout(decorateTimer);
      }
      decorateTimer = setTimeout(function () {
        decorateTimer = null;
        if (!started || !native.flowRoot || !native.subflowRoot) {
          return;
        }
        decorateCombinedRoot();
        applyWorkspaceFilter();
        updateFooterButtons();
        restoreExplorerViewport(viewport);
      }, 0);
      if (changed) {
        scheduleConfigSave();
      }
    } catch (err) {
      restoreExplorerViewport(viewport);
      console.error("[folders] Native Explorer reconciliation failed.", err);
      notify(
        "Folders could not update the native Explorer. Its normal rows were left available.",
        "error",
      );
    } finally {
      reconciling = false;
    }
  }

  function scheduleReconcile(delay) {
    if (!started) {
      return;
    }
    if (reconcileTimer) {
      clearTimeout(reconcileTimer);
    }
    reconcileTimer = setTimeout(
      reconcileNativeTree,
      delay === undefined ? 60 : delay,
    );
  }

  function explorerScrollContainer() {
    if (!native.outline || !native.outline.length) {
      return $();
    }
    let best = native.outline;
    let bestRange = Math.max(
      0,
      native.outline[0].scrollHeight - native.outline[0].clientHeight,
    );
    native.outline
      .find(".red-ui-treeList,.red-ui-editableList-container")
      .each(function () {
        const range = Math.max(0, this.scrollHeight - this.clientHeight);
        if (range > bestRange) {
          best = $(this);
          bestRange = range;
        }
      });
    return best;
  }

  function captureExplorerViewport() {
    const container = explorerScrollContainer();
    if (container.length) {
      lastExplorerViewport = {
        top: container.scrollTop(),
        left: container.scrollLeft(),
      };
    }
    return {
      top: lastExplorerViewport.top,
      left: lastExplorerViewport.left,
    };
  }

  function restoreExplorerViewport(viewport) {
    if (!viewport) {
      return;
    }
    lastExplorerViewport = { top: viewport.top, left: viewport.left };
    [0, 40].forEach(function (delay) {
      setTimeout(function () {
        const container = explorerScrollContainer();
        if (container.length) {
          container.scrollTop(viewport.top).scrollLeft(viewport.left);
        }
      }, delay);
    });
  }

  function bindExplorerScrollTracking() {
    if (scrollTrackingElement && scrollTrackingHandler) {
      scrollTrackingElement.removeEventListener(
        "scroll",
        scrollTrackingHandler,
        true,
      );
      ["wheel", "touchstart", "pointerdown", "keydown"].forEach(
        function (eventName) {
          scrollTrackingElement.removeEventListener(
            eventName,
            scrollIntentHandler,
            true,
          );
        },
      );
    }
    scrollTrackingElement = native.outline && native.outline[0];
    if (!scrollTrackingElement) {
      scrollTrackingHandler = null;
      scrollIntentHandler = null;
      return;
    }
    scrollIntentHandler = function () {
      scrollIntentUntil = Date.now() + 1500;
    };
    scrollTrackingHandler = function () {
      if (Date.now() > scrollIntentUntil) {
        return;
      }
      const container = explorerScrollContainer();
      if (container.length) {
        lastExplorerViewport = {
          top: container.scrollTop(),
          left: container.scrollLeft(),
        };
      }
    };
    scrollTrackingElement.addEventListener(
      "scroll",
      scrollTrackingHandler,
      true,
    );
    ["wheel", "touchstart", "pointerdown", "keydown"].forEach(
      function (eventName) {
        scrollTrackingElement.addEventListener(
          eventName,
          scrollIntentHandler,
          true,
        );
      },
    );
  }

  function setRootListItemVisible(item, visible) {
    if (item && item.treeList && item.treeList.container) {
      item.treeList.container.closest("li").toggle(!!visible);
    }
  }

  function switchMode(mode) {
    native.mode = mode === "configuration" ? "configuration" : "explorer";
    if (!native.outline) {
      return;
    }
    native.outline.toggleClass(
      "folders-native-configuration-active",
      native.mode === "configuration",
    );
    if (native.headerToggle) {
      native.headerToggle.text(native.mode === "explorer" ? "Config" : "Flow");
    }
    setRootListItemVisible(native.flowRoot, native.mode === "explorer");
    setRootListItemVisible(native.subflowRoot, false);
    setRootListItemVisible(native.configRoot, native.mode === "configuration");
    if (native.searchToolbar) {
      const searchInput = native.searchToolbar.find(".red-ui-searchBox-input");
      if (searchInput.val()) {
        searchInput.val("").trigger("change").trigger("keyup");
      }
      searchInput.attr(
        "placeholder",
        native.mode === "configuration"
          ? "Search configurations"
          : "Search flows",
      );
      native.searchToolbar.show();
    }
    native.controls.toggle(native.mode === "explorer");
    native.footer.toggle(native.mode === "explorer");
    if (
      native.mode === "configuration" &&
      native.configRoot &&
      native.configRoot.treeList
    ) {
      setItemExpandedInstant(native.configRoot, true);
    } else if (native.flowRoot && native.flowRoot.treeList) {
      setItemExpandedInstant(native.flowRoot, true);
      applyWorkspaceFilter();
    }
    saveLocalState();
  }

  function selectedFolderContext() {
    if (!native.tree) {
      return null;
    }
    const primary = selectionEntry(primarySelectionKey);
    if (primary) {
      if (primary.type === "folder") {
        return {
          type: "folder",
          kind: "flow",
          path: Model.normalisePath(primary.id),
          item: itemForSelectionKey(primarySelectionKey),
        };
      }
      const meta = nativeItemMeta(primary.type, primary.id) || {};
      return {
        type: "item",
        kind: primary.type,
        id: primary.id,
        item: itemForSelectionKey(primarySelectionKey),
        path: Model.normalisePath(meta.path || ""),
      };
    }
    const row = native.tree
      .find(".red-ui-treeList-label.selected .folders-native-folder-row")
      .first();
    if (row.length) {
      return {
        type: "folder",
        kind: "flow",
        path: Model.normalisePath(row.attr("data-folder-path") || ""),
      };
    }
    const selectedLabel = native.tree
      .find(".red-ui-treeList-label.selected")
      .first();
    const item = selectedLabel
      .closest(".red-ui-editableList-item-content")
      .data("data");
    if (item && item.id) {
      const kind = findWorkspace(item.id)
        ? "flow"
        : findSubflow(item.id)
          ? "subflow"
          : null;
      if (kind) {
        const meta = nativeItemMeta(kind, item.id) || {};
        return {
          type: "item",
          kind: kind,
          id: item.id,
          item: item,
          path: Model.normalisePath(meta.path || ""),
        };
      }
      const node = RED.nodes.node(item.id) || RED.nodes.group(item.id);
      if (node) {
        const ownerKind = findSubflow(node.z) ? "subflow" : "flow";
        const ownerMeta = nativeItemMeta(ownerKind, node.z) || {};
        return {
          type: "node",
          kind: ownerKind,
          id: item.id,
          item: item,
          path: Model.normalisePath(ownerMeta.path || ""),
        };
      }
    }
    return null;
  }

  function targetPathFromSelection() {
    const selected = selectedFolderContext();
    if (!selected) {
      return "";
    }
    return selected.type === "folder"
      ? selected.path
      : Model.normalisePath(selected.path || "");
  }

  function siblingNames(parent, excludeId) {
    const cleanParent = Model.normalisePath(parent);
    const names = new Set();
    const folders = Model.stores(folderConfig, "flow").folders;
    Object.keys(folders).forEach(function (path) {
      if (Model.parentPath(path) === cleanParent) {
        names.add(
          String(folders[path].name || Model.baseName(path)).toLowerCase(),
        );
      }
    });
    ["flow", "subflow"].forEach(function (kind) {
      const items = Model.stores(folderConfig, kind).items;
      Object.keys(items).forEach(function (id) {
        if (
          id !== excludeId &&
          Model.normalisePath(items[id].path) === cleanParent
        ) {
          names.add(itemLabel(nativeNode(kind, id)).toLowerCase());
        }
      });
    });
    return names;
  }

  function uniqueSiblingName(baseName, parent, excludeId) {
    const names = siblingNames(parent, excludeId);
    let index = 1;
    let name = baseName;
    while (names.has(name.toLowerCase())) {
      index += 1;
      name = baseName + " " + index;
    }
    return name;
  }

  function uniqueFolderPath(parent) {
    const cleanParent = Model.normalisePath(parent);
    const name = uniqueSiblingName("New folder", cleanParent);
    const path = Model.normalisePath(
      (cleanParent ? cleanParent + "/" : "") + name,
    );
    return { name: name, path: path };
  }

  function createFolderFromSelection() {
    createFolderAt(targetPathFromSelection());
  }

  function createFolderAt(parent) {
    const folder = uniqueFolderPath(parent);
    const inherited = inheritedFolderStates(parent);
    Model.ensureFolder(folderConfig, "flow", folder.path, {
      name: folder.name,
      hidden: inherited.hidden,
      disabled: inherited.disabled,
      locked: inherited.locked,
    });
    pendingRename = {
      type: "folder",
      path: folder.path,
    };
    scheduleConfigSave(true);
    scheduleReconcile(0);
  }

  function finishFlowCreation(beforeIds, path, attempt) {
    const created = getWorkspaces().find(function (flow) {
      return flow && flow.id && !beforeIds.has(flow.id);
    });
    if (created) {
      structureUpdateUntil = Date.now() + 900;
      created.label = uniqueSiblingName("New flow", path, created.id);
      created.changed = true;
      RED.nodes.dirty(true);
      Model.setItemPath(
        folderConfig,
        "flow",
        created.id,
        path,
        itemLabel(created),
      );
      applyInheritedStatesToFlow(created, path, { forceEnabled: true });
      try {
        RED.events.emit("flows:change", created);
        if (RED.workspaces && RED.workspaces.refresh) {
          RED.workspaces.refresh();
        }
      } catch (err) {}
      pendingRename = {
        type: "item",
        kind: "flow",
        id: created.id,
        path: path,
      };
      scheduleConfigSave(true);
      scheduleReconcile(0);
      return;
    }
    if (attempt < 12) {
      setTimeout(function () {
        finishFlowCreation(beforeIds, path, attempt + 1);
      }, 75);
    }
  }

  function createFlowFromSelection() {
    createFlowAt(targetPathFromSelection());
  }

  function createFlowAt(path) {
    const beforeIds = new Set(
      getWorkspaces().map(function (flow) {
        return flow.id;
      }),
    );
    try {
      structureUpdateUntil = Date.now() + 900;
      RED.actions.invoke("core:add-flow");
      finishFlowCreation(beforeIds, Model.normalisePath(path), 0);
    } catch (err) {
      notify("Node-RED could not create a new flow.", "error");
    }
  }

  function getFilterLabel() {
    const labels = {
      all: "All",
      flows: "Flows",
      subflows: "Subflows",
      shown: "Shown",
      hidden: "Hidden",
      enabled: "Enabled",
      disabled: "Disabled",
      locked: "Locked",
      unlocked: "Unlocked",
    };
    return labels[filterMode] || "All";
  }

  function updateHeaderControls() {
    if (native.filterButton) {
      native.filterButton.find("span").text(getFilterLabel());
    }
    if (native.sortButton) {
      const labels = {
        name: "Name",
        created: "Created",
        updated: "Updated",
        type: "Type",
      };
      native.sortButton.find("span").text(labels[sortMode] || "Name");
    }
    if (native.sortDirectionButton) {
      const descending = sortDirection === "desc";
      native.sortDirectionButton
        .attr("title", descending ? "Descending" : "Ascending")
        .attr("aria-label", descending ? "Descending" : "Ascending")
        .empty()
        .append(
          $("<i>", {
            class: descending ? "fa fa-arrow-down" : "fa fa-arrow-up",
          }),
        );
    }
  }

  function closeHeaderMenus() {
    $(".folders-header-menu").remove();
  }

  function openHeaderMenu(anchor, mode) {
    const existing = $('.folders-header-menu[data-mode="' + mode + '"]');
    if (existing.length) {
      closeHeaderMenus();
      return;
    }
    closeHeaderMenus();
    const options =
      mode === "sort"
        ? [
            ["name", "Name"],
            ["created", "Created"],
            ["updated", "Updated"],
            ["type", "Type"],
          ]
        : [
            ["all", "All"],
            ["flows", "Flows"],
            ["subflows", "Subflows"],
            ["shown", "Shown"],
            ["hidden", "Hidden"],
            ["enabled", "Enabled"],
            ["disabled", "Disabled"],
            ["unlocked", "Unlocked"],
            ["locked", "Locked"],
          ];
    const current = mode === "sort" ? sortMode : filterMode;
    const menu = $("<div>", {
      class: "folders-menu folders-header-menu",
      "data-mode": mode,
    }).appendTo("body");
    options.forEach(function (option) {
      $("<a>", {
        href: "#",
        class: option[0] === current ? "selected" : "",
      })
        .append(
          $("<span>", { class: "folders-menu-check" }).append(
            option[0] === current
              ? $("<i>", { class: "fa fa-check folders-menu-check-icon" })
              : "",
          ),
          $("<span>", { text: option[1] }),
        )
        .appendTo(menu)
        .on("click" + EVENT_NAMESPACE, function (event) {
          event.preventDefault();
          if (mode === "sort") {
            sortMode = option[0];
            sortCombinedTreeInPlace();
          } else {
            filterMode = option[0];
            applyWorkspaceFilter();
          }
          updateHeaderControls();
          saveLocalState();
          closeHeaderMenus();
        });
    });
    const position = anchor.offset();
    menu.css({
      left: position.left,
      top: position.top + anchor.outerHeight() + 2,
    });
  }

  function itemPassesFilter(item) {
    const kind = itemKind(item);
    const node = kind && nativeNode(kind, item.id);
    if (!kind || !node || filterMode === "all") {
      return true;
    }
    if (filterMode === "flows") {
      return kind === "flow";
    }
    if (filterMode === "subflows") {
      return kind === "subflow";
    }
    if (filterMode === "shown") {
      return !isHidden(node);
    }
    if (filterMode === "hidden") {
      return isHidden(node);
    }
    if (kind !== "flow") {
      return false;
    }
    if (filterMode === "enabled") {
      return !isDisabled(node);
    }
    if (filterMode === "disabled") {
      return isDisabled(node);
    }
    if (filterMode === "locked") {
      return isLocked(node);
    }
    return !isLocked(node);
  }

  function applyWorkspaceFilter() {
    if (!native.flowRoot || native.mode !== "explorer") {
      return;
    }
    function apply(item) {
      let visible;
      if (item.__foldersFolder) {
        visible = (item.children || []).map(apply).some(Boolean);
        if (filterMode === "all") {
          visible = true;
        }
      } else {
        visible = itemPassesFilter(item);
      }
      if (item.treeList && item.treeList.container) {
        item.treeList.container.parent().toggle(visible);
      }
      return visible;
    }
    (native.flowRoot.children || []).forEach(apply);
  }

  function updateFooterButtons() {
    const canStyle = appearanceTargetsFromSelection().length > 0;
    const canDelete = Array.from(selectedKeys).some(function (key) {
      const entry = selectionEntry(key);
      return entry && (entry.type === "folder" || entry.type === "flow");
    });
    if (native.footerStyleButton) {
      native.footerStyleButton
        .prop("disabled", !canStyle)
        .toggleClass("disabled", !canStyle)
        .toggle(canStyle);
    }
    if (native.footerDeleteButton) {
      native.footerDeleteButton
        .prop("disabled", !canDelete)
        .toggleClass("disabled", !canDelete)
        .toggle(canDelete);
    }
  }

  function appearanceTargetsFromSelection() {
    const targets = [];
    const seen = new Set();
    selectedKeys.forEach(function (key) {
      const entry = selectionEntry(key);
      if (!entry) {
        return;
      }
      let target = null;
      if (entry.type === "folder") {
        target = { type: "folder", kind: "flow", path: entry.id };
      } else if (entry.type === "flow") {
        target = { type: "item", kind: "flow", id: entry.id };
      }
      if (target) {
        const targetKey =
          target.type === "folder"
            ? "folder:" + Model.normalisePath(target.path)
            : target.kind + ":" + target.id;
        if (!seen.has(targetKey)) {
          seen.add(targetKey);
          targets.push(target);
        }
      }
    });
    if (!targets.length) {
      const selected = selectedFolderContext();
      if (selected && selected.type === "folder") {
        targets.push({
          type: "folder",
          kind: "flow",
          path: selected.path,
        });
      } else if (
        selected &&
        selected.type === "item" &&
        selected.kind === "flow"
      ) {
        targets.push({ type: "item", kind: "flow", id: selected.id });
      }
    }
    return targets;
  }

  function styleSelectedItem() {
    const targets = appearanceTargetsFromSelection();
    if (!targets.length) {
      return;
    }
    openAppearanceDialog(targets);
  }

  function nodeCountForContainer(id) {
    let count = 0;
    try {
      RED.nodes.eachNode(function (node) {
        if (node && node.z === id) {
          count += 1;
        }
      });
    } catch (err) {}
    return count;
  }

  function compactFolderPaths(paths) {
    return Array.from(new Set(paths.map(Model.normalisePath).filter(Boolean)))
      .sort(function (left, right) {
        return left.length - right.length;
      })
      .filter(function (path, index, all) {
        return !all.slice(0, index).some(function (parent) {
          return path.indexOf(parent + "/") === 0;
        });
      });
  }

  function pathIsInsideFolders(value, folderRoots) {
    const path = Model.normalisePath(value);
    return folderRoots.some(function (folderPath) {
      return path === folderPath || path.indexOf(folderPath + "/") === 0;
    });
  }

  function buildDeletionPlan(keys) {
    const entries = keys.map(selectionEntry).filter(Boolean);
    const folderRoots = compactFolderPaths(
      entries
        .filter(function (entry) {
          return entry.type === "folder";
        })
        .map(function (entry) {
          return entry.id;
        }),
    );
    const flowIds = new Set(
      entries
        .filter(function (entry) {
          return entry.type === "flow";
        })
        .map(function (entry) {
          return entry.id;
        }),
    );
    const subflowIds = new Set(
      entries
        .filter(function (entry) {
          return entry.type === "subflow";
        })
        .map(function (entry) {
          return entry.id;
        }),
    );
    ["flow", "subflow"].forEach(function (kind) {
      const items = Model.stores(folderConfig, kind).items;
      Object.keys(items).forEach(function (id) {
        if (pathIsInsideFolders(items[id].path, folderRoots)) {
          (kind === "flow" ? flowIds : subflowIds).add(id);
        }
      });
    });
    const folderPaths = new Set();
    ["flow", "subflow"].forEach(function (kind) {
      const folders = Model.stores(folderConfig, kind).folders;
      Object.keys(folders).forEach(function (folderPath) {
        if (pathIsInsideFolders(folderPath, folderRoots)) {
          folderPaths.add(folderPath);
        }
      });
    });
    const flows = Array.from(flowIds).map(findWorkspace).filter(Boolean);
    const subflows = Array.from(subflowIds).map(findSubflow).filter(Boolean);
    const populated = flows
      .map(function (flow) {
        return {
          kind: "Flow",
          name: itemLabel(flow),
          count: nodeCountForContainer(flow.id),
        };
      })
      .concat(
        subflows.map(function (subflow) {
          return {
            kind: "Subflow",
            name: itemLabel(subflow),
            count: nodeCountForContainer(subflow.id),
          };
        }),
      )
      .filter(function (item) {
        return item.count > 0;
      });
    return {
      folderRoots: folderRoots,
      folderPaths: Array.from(folderPaths),
      flowIds: Array.from(flowIds),
      subflowIds: Array.from(subflowIds),
      flows: flows,
      subflows: subflows,
      populated: populated,
    };
  }

  function ensureFlowRemains(plan) {
    if (!plan.flows.length || plan.flows.length < getWorkspaces().length) {
      return;
    }
    const before = new Set(
      getWorkspaces().map(function (flow) {
        return flow.id;
      }),
    );
    RED.actions.invoke("core:add-flow");
    const replacement = getWorkspaces().find(function (flow) {
      return !before.has(flow.id);
    });
    if (replacement) {
      Model.setItemPath(
        folderConfig,
        "flow",
        replacement.id,
        "",
        itemLabel(replacement),
      );
    }
  }

  function executeDeletionPlan(plan) {
    try {
      ensureFlowRemains(plan);
      plan.subflows.forEach(function (subflow) {
        if (RED.subflow && typeof RED.subflow.removeSubflow === "function") {
          const historyEvent = RED.subflow.removeSubflow(subflow.id);
          if (historyEvent) {
            historyEvent.t = "delete";
            historyEvent.dirty = RED.nodes.dirty();
            RED.history.push(historyEvent);
          }
        } else if (RED.nodes.removeSubflow) {
          RED.nodes.removeSubflow(subflow.id);
        }
      });
      plan.flows.forEach(function (flow) {
        if (isLocked(flow)) {
          RED.workspaces.unlock(flow.id);
        }
        RED.workspaces.delete(flow);
      });
      // Remove every stored reference collected for the deleted tree. Some
      // older configurations can contain IDs for flows or subflows that no
      // longer exist, so they cannot be removed through the live editor API.
      // Leaving one of those records behind would recreate its folder when
      // the folder indexes are rebuilt during the save.
      ["flow", "subflow"].forEach(function (kind) {
        const target = Model.stores(folderConfig, kind);
        const selectedIds = new Set(
          kind === "flow" ? plan.flowIds : plan.subflowIds,
        );
        Object.keys(target.items).forEach(function (id) {
          if (
            selectedIds.has(id) ||
            pathIsInsideFolders(target.items[id].path, plan.folderRoots)
          ) {
            delete target.items[id];
          }
        });
        Object.keys(target.folders).forEach(function (path) {
          if (pathIsInsideFolders(path, plan.folderRoots)) {
            delete target.folders[path];
          }
        });
      });
      Array.from(collapsedFolders).forEach(function (key) {
        if (
          plan.folderPaths.some(function (path) {
            return key === "flow:" + path;
          })
        ) {
          collapsedFolders.delete(key);
        }
      });
      saveLocalState();
      selectedKeys.clear();
      primarySelectionKey = null;
      selectionAnchorKey = null;
      scheduleConfigSave(true);
      scheduleReconcile(0);
      notify("Selected content deleted.");
    } catch (err) {
      console.error("[folders] Delete failed.", err);
      notify("The selected content could not be deleted.", "error");
    }
  }

  function openDeletionPlan(plan) {
    if (!plan.populated.length) {
      executeDeletionPlan(plan);
      return;
    }
    const content = $("<div>");
    const hasFolders = plan.folderPaths.length > 0;
    $("<p>", {
      text: hasFolders
        ? "This permanently deletes the selected folders and everything inside them."
        : "This permanently deletes the selected flows and all nodes inside them.",
    }).appendTo(content);
    const summary = hasFolders
      ? [
          plan.folderPaths.length + " folder(s)",
          plan.flows.length + " flow(s)",
          plan.subflows.length + " subflow(s)",
        ].join(", ") + " will be deleted."
      : plan.flows.length +
        (plan.flows.length === 1
          ? " selected flow will be deleted."
          : " selected flows will be deleted.");
    $("<p>", { text: summary }).appendTo(content);
    $("<strong>", { text: "Flows containing nodes:" }).appendTo(content);
    const list = $("<ul>", { class: "folders-delete-list" }).appendTo(content);
    plan.populated.forEach(function (item) {
      $("<li>", {
        text:
          item.kind +
          " “" +
          item.name +
          "” — " +
          item.count +
          (item.count === 1 ? " node" : " nodes"),
      }).appendTo(list);
    });
    confirmDialog(
      hasFolders ? "Delete folders and contents" : "Delete flows",
      content,
      hasFolders
        ? "Delete everything"
        : "Delete flow" + (plan.flows.length === 1 ? "" : "s"),
      function () {
        executeDeletionPlan(plan);
      },
    );
  }

  function deleteSelectedItem() {
    const selected = selectedFolderContext();
    const eligible = Array.from(selectedKeys).filter(function (key) {
      const entry = selectionEntry(key);
      return entry && (entry.type === "folder" || entry.type === "flow");
    });
    if (!eligible.length && !selected) {
      return;
    }
    const fallback =
      selected && selected.type === "folder"
        ? "folder:" + selected.path
        : selected && selected.type === "item" && selected.kind === "flow"
          ? "flow:" + selected.id
          : null;
    if (!eligible.length && !fallback) {
      return;
    }
    openDeletionPlan(
      buildDeletionPlan(eligible.length ? eligible : [fallback]),
    );
  }

  function buildControls() {
    native.headerToggle = $("<button>", {
      type: "button",
      class: "red-ui-button red-ui-button-small folders-header-toggle",
      title: "Switch Explorer view",
    })
      .appendTo(native.bannerTools)
      .on("click" + EVENT_NAMESPACE, function (event) {
        event.preventDefault();
        switchMode(native.mode === "explorer" ? "configuration" : "explorer");
        this.blur();
      });

    native.controls = $("<div>", {
      class: "red-ui-sidebar-header folders-header",
    });
    const filterGroup = $("<span>", { class: "button-group" }).appendTo(
      native.controls,
    );
    native.filterButton = $("<a>", {
      href: "#",
      class:
        "red-ui-button red-ui-button-small folders-header-control " +
        "folders-filter-button",
      title: "Filter flows",
    })
      .html(
        '<i class="fa fa-filter"></i> <span></span> <i class="fa fa-caret-down"></i>',
      )
      .appendTo(filterGroup)
      .on("click" + EVENT_NAMESPACE, function (event) {
        event.preventDefault();
        openHeaderMenu(native.filterButton, "filter");
      });
    const sortGroup = $("<span>", { class: "button-group" }).appendTo(
      native.controls,
    );
    native.sortButton = $("<a>", {
      href: "#",
      class:
        "red-ui-button red-ui-button-small folders-header-control " +
        "folders-sort-button",
      title: "Sort workspace",
    })
      .html(
        '<i class="fa fa-sort"></i> <span></span> <i class="fa fa-caret-down"></i>',
      )
      .appendTo(sortGroup)
      .on("click" + EVENT_NAMESPACE, function (event) {
        event.preventDefault();
        openHeaderMenu(native.sortButton, "sort");
      });
    const directionGroup = $("<span>", {
      class: "button-group folders-dir-group",
    }).appendTo(native.controls);
    native.sortDirectionButton = $("<a>", {
      href: "#",
      class:
        "red-ui-button red-ui-button-small folders-header-control " +
        "folders-sort-dir",
      title: "Ascending",
    })
      .appendTo(directionGroup)
      .on("click" + EVENT_NAMESPACE, function (event) {
        event.preventDefault();
        sortDirection = sortDirection === "asc" ? "desc" : "asc";
        updateHeaderControls();
        saveLocalState();
        sortCombinedTreeInPlace();
      });
    native.controls.insertAfter(native.searchToolbar);

    native.footer = $("<div>", { class: "folders-footer" }).appendTo(
      native.outline,
    );
    const footerLeft = $("<div>", { class: "folders-footer-left" }).appendTo(
      native.footer,
    );
    $("<button>", {
      type: "button",
      class: "red-ui-button red-ui-button-small",
      title: "New folder",
    })
      .html(
        '<i class="fa fa-plus folders-footer-plus"></i><i class="fa fa-folder"></i>',
      )
      .appendTo(footerLeft)
      .on("click" + EVENT_NAMESPACE, createFolderFromSelection);
    $("<button>", {
      type: "button",
      class: "red-ui-button red-ui-button-small",
      title: "New flow",
    })
      .html(
        '<i class="fa fa-plus folders-footer-plus"></i><i class="red-ui-icons red-ui-icons-flow folders-footer-flow-icon"></i>',
      )
      .appendTo(footerLeft)
      .on("click" + EVENT_NAMESPACE, createFlowFromSelection);
    const footerRight = $("<div>", {
      class: "folders-footer-right",
    }).appendTo(native.footer);
    native.footerStyleButton = $("<button>", {
      type: "button",
      class: "red-ui-button red-ui-button-small",
      title: "Appearance",
    })
      .html('<i class="fa fa-tint"></i>')
      .appendTo(footerRight)
      .on("click" + EVENT_NAMESPACE, styleSelectedItem);
    native.footerDeleteButton = $("<button>", {
      type: "button",
      class: "red-ui-button red-ui-button-small folders-danger",
      title: "Delete",
    })
      .html('<i class="fa fa-trash"></i>')
      .appendTo(footerRight)
      .on("click" + EVENT_NAMESPACE, deleteSelectedItem);

    native.tree
      .off("treelistselect.folders-native-footer")
      .on("treelistselect.folders-native-footer", updateFooterButtons);
    native.tree
      .off("treelistchildrenloaded.folders-native-indent")
      .on(
        "treelistchildrenloaded.folders-native-indent",
        function (event, item) {
          let root = item;
          while (root && root.parent) {
            root = root.parent;
          }
          normaliseVisibleIndent(
            item,
            root === native.configRoot ? 1 : root === native.flowRoot ? 1 : 0,
          );
          if (
            desiredExpansionStates.has(item) &&
            !desiredExpansionState(item)
          ) {
            applyExpansionVisual(item, false, false);
          }
        },
      );
    $(document)
      .off("mousedown.folders-header-menu")
      .on("mousedown.folders-header-menu", function (event) {
        if (!$(event.target).closest(".folders-menu,.folders-header").length) {
          closeHeaderMenus();
        }
      });
    updateHeaderControls();
    updateFooterButtons();
  }

  function attachNativeExplorer() {
    attachTimer = null;
    if (!started) {
      return;
    }
    const found = findNativeExplorer();
    if (!found) {
      if (!compatibilityWarningShown) {
        compatibilityWarningShown = true;
        console.warn(
          "[folders] Waiting for Node-RED 5 native Explorer TreeList.",
        );
      }
      scheduleAttach(250);
      return;
    }
    compatibilityWarningShown = false;
    if (native.tree && native.tree[0] === found.tree[0]) {
      scheduleReconcile();
      return;
    }
    pendingExplorerViewport = native.outline
      ? captureExplorerViewport()
      : {
          top: lastExplorerViewport.top,
          left: lastExplorerViewport.left,
        };
    detachUiOnly();
    native.outline = found.outline.addClass(
      "folders-native-explorer folders-explorer",
    );
    native.tree = found.tree;
    native.searchToolbar = native.outline
      .children(".red-ui-info-toolbar")
      .first();
    native.searchOptions = native.searchToolbar
      .find(".red-ui-searchBox-opts")
      .detach();
    native.searchToolbar
      .find(".red-ui-searchBox-container")
      .removeClass("red-ui-searchBox-has-options");
    const section = native.outline.closest(".red-ui-sidebar-section");
    native.bannerTools = section.find(".red-ui-sidebar-banner-tools").first();
    if (!native.bannerTools.length) {
      native.bannerTools = $("<div>", {
        class: "red-ui-sidebar-banner-tools",
      }).appendTo(section.find(".red-ui-sidebar-banner").first());
    }
    native.ownedChildren = native.outline
      .children()
      .addClass("folders-native-owned");
    bindExplorerScrollTracking();
    buildControls();
    bindExplorerInteractions();
    switchMode(native.mode);
    scheduleReconcile(0);
  }

  function scheduleAttach(delay) {
    if (!started) {
      return;
    }
    if (attachTimer) {
      clearTimeout(attachTimer);
    }
    attachTimer = setTimeout(
      attachNativeExplorer,
      delay === undefined ? 100 : delay,
    );
  }

  function treeItemFromLabel(label) {
    return label.closest(".red-ui-editableList-item-content").data("data");
  }

  function selectTreeItem(item, event) {
    if (!item || !native.tree) {
      return;
    }
    const key = selectionKeyForItem(item);
    if (!key) {
      selectedKeys.clear();
      primarySelectionKey = null;
      selectionAnchorKey = null;
      try {
        native.tree.treeList("clearSelection");
        native.tree.treeList("select", item, false);
      } catch (err) {}
      updateFooterButtons();
      return;
    }
    const additive = !!(event && (event.ctrlKey || event.metaKey));
    const ranged = !!(event && event.shiftKey && selectionAnchorKey);
    if (ranged) {
      const items = visibleSelectableItems();
      const keys = items.map(selectionKeyForItem);
      const rangeKeys = selectionRangeKeys(keys, selectionAnchorKey, key);
      if (!additive) {
        selectedKeys.clear();
      }
      if (rangeKeys.length) {
        rangeKeys.forEach(function (rangeKey) {
          selectedKeys.add(rangeKey);
        });
      } else {
        selectedKeys.add(key);
        selectionAnchorKey = key;
      }
    } else if (additive) {
      if (selectedKeys.has(key)) {
        selectedKeys.delete(key);
      } else {
        selectedKeys.add(key);
      }
      selectionAnchorKey = key;
    } else {
      selectedKeys.clear();
      selectedKeys.add(key);
      selectionAnchorKey = key;
    }
    primarySelectionKey = selectedKeys.has(key)
      ? key
      : selectedKeys.values().next().value || null;
    applySelectionToTree();
    updateFooterButtons();
  }

  function selectForContextMenu(item) {
    const key = selectionKeyForItem(item);
    if (key && selectedKeys.has(key)) {
      primarySelectionKey = key;
      applySelectionToTree();
      updateFooterButtons();
    } else {
      selectTreeItem(item);
    }
  }

  function openTreeItem(item) {
    if (!item) {
      return;
    }
    if (item.__foldersFolder) {
      const expanded = nextExpansionState(item);
      setItemExpandedAnimated(item, expanded);
      const key = folderStateKey(item.folderKind, item.folderPath);
      if (expanded) {
        collapsedFolders.delete(key);
      } else {
        collapsedFolders.add(key);
      }
      saveLocalState();
      return;
    }
    const kind = itemKind(item);
    if (kind) {
      const node = nativeNode(kind, item.id);
      if (!node) {
        return;
      }
      RED.workspaces.show(node.id);
      setTimeout(function () {
        if (kind === "subflow" && RED.editor.editSubflow) {
          RED.editor.editSubflow(node);
        } else if (kind === "flow" && RED.editor.editFlow) {
          RED.editor.editFlow(node);
        }
      }, 0);
      return;
    }
    const node = RED.nodes.node(item.id) || RED.nodes.group(item.id);
    if (!node) {
      return;
    }
    const isConfig = node._def && node._def.category === "config";
    if (isConfig) {
      RED.editor.editConfig("", node.type, node.id);
      return;
    }
    RED.view.reveal(node.id);
    if (node.type === "group" && RED.editor.editGroup) {
      RED.editor.editGroup(node);
    } else {
      RED.editor.edit(node);
    }
  }

  function renameSelectedTreeItem() {
    const label = native.tree.find(".red-ui-treeList-label.selected").first();
    const item = treeItemFromLabel(label);
    if (!item) {
      return;
    }
    if (item.__foldersFolder) {
      startInlineFolderRename($(item.element), {
        path: item.folderPath,
        name: Model.baseName(item.folderPath),
      });
      return;
    }
    const kind = itemKind(item);
    startInlineItemRename(item, kind || "node");
  }

  function openRootMenu(event) {
    const menu = createMenu(event);
    addMenuItem(menu, "New folder", "fa fa-folder", function () {
      createFolderAt("");
    });
    addMenuItem(
      menu,
      "New flow",
      "red-ui-icons red-ui-icons-flow",
      function () {
        createFlowAt("");
      },
    );
  }

  function bindExplorerInteractions() {
    if (treeClickCapture && native.tree && native.tree[0]) {
      native.tree[0].removeEventListener("click", treeClickCapture, true);
      native.tree[0].removeEventListener("dblclick", treeClickCapture, true);
    }
    treeClickCapture = function (event) {
      const label = $(event.target).closest(".red-ui-treeList-label");
      if (!label.length || !native.tree[0].contains(label[0])) {
        return;
      }
      if ($(event.target).closest("button,input,a").length) {
        return;
      }
      const item = treeItemFromLabel(label);
      if (!item) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      selectTreeItem(item, event);
      if (item.__foldersFolder) {
        showFolderInfo(item.folderKind, item.folderPath);
      } else {
        $(".folders-native-info-panel").remove();
      }
      const toggle = $(event.target).closest(".red-ui-treeList-icon");
      const isConfigType =
        native.mode === "configuration" &&
        item.treeList &&
        item.treeList.container &&
        item.treeList.container.hasClass("folders-native-config-type");
      const isPrimaryToggle =
        toggle.length &&
        toggle[0] === label.children(".red-ui-treeList-icon").first()[0];
      if (
        event.type === "click" &&
        (isConfigType || isPrimaryToggle) &&
        item.children
      ) {
        const expanded = nextExpansionState(item);
        setItemExpandedAnimated(item, expanded);
        if (item.__foldersFolder) {
          const key = folderStateKey(item.folderKind, item.folderPath);
          if (expanded) {
            collapsedFolders.delete(key);
          } else {
            collapsedFolders.add(key);
          }
          saveLocalState();
        }
        return;
      }
      if (event.type === "dblclick" && (isConfigType || isPrimaryToggle)) {
        return;
      }
      const kind = itemKind(item);
      if (
        event.type === "click" &&
        kind &&
        !(event.ctrlKey || event.metaKey || event.shiftKey)
      ) {
        RED.workspaces.show(item.id);
      }
      if (event.type === "dblclick") {
        openTreeItem(item);
      }
    };
    native.tree[0].addEventListener("click", treeClickCapture, true);
    native.tree[0].addEventListener("dblclick", treeClickCapture, true);

    native.tree
      .off("contextmenu.folders-native-root")
      .on("contextmenu.folders-native-root", function (event) {
        const label = $(event.target).closest(".red-ui-treeList-label");
        if (label.length) {
          const item = treeItemFromLabel(label);
          if (item && !item.__foldersFolder && itemKind(item) !== "flow") {
            event.preventDefault();
            event.stopPropagation();
          }
          return;
        }
        if (native.mode !== "explorer") {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        selectedKeys.clear();
        primarySelectionKey = null;
        selectionAnchorKey = null;
        try {
          native.tree.treeList("clearSelection");
        } catch (err) {}
        updateFooterButtons();
        openRootMenu(event);
      })
      .off("dragover.folders-native-root drop.folders-native-root")
      .on("dragover.folders-native-root", function (event) {
        if (
          native.mode === "explorer" &&
          !$(event.target).closest(".red-ui-treeList-label").length
        ) {
          event.preventDefault();
        }
      })
      .on("drop.folders-native-root", function (event) {
        if (
          native.mode !== "explorer" ||
          $(event.target).closest(".red-ui-treeList-label").length
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        applyDrop(getDragData(event), "flow", "");
      })
      .off("keydown.folders-native-rename")
      .on("keydown.folders-native-rename", function (event) {
        if (event.key === "F2") {
          event.preventDefault();
          renameSelectedTreeItem();
        }
      });
    $(document)
      .off("keydown.folders-native-rename")
      .on("keydown.folders-native-rename", function (event) {
        if (
          event.key === "F2" &&
          native.mode === "explorer" &&
          native.outline &&
          native.outline.is(":visible") &&
          !$(event.target).is("input,textarea,select")
        ) {
          event.preventDefault();
          renameSelectedTreeItem();
        }
      });
  }

  function nodeContainsExplorer(records) {
    return records.some(function (record) {
      return Array.from(record.addedNodes || [])
        .concat(Array.from(record.removedNodes || []))
        .some(function (node) {
          return (
            node.nodeType === 1 &&
            ($(node).is(".red-ui-info-outline,.red-ui-treeList") ||
              $(node).find(".red-ui-info-outline,.red-ui-treeList").length)
          );
        });
    });
  }

  function initObserver() {
    if (!window.MutationObserver || nativeObserver) {
      return;
    }
    nativeObserver = new MutationObserver(function (records) {
      if (nodeContainsExplorer(records)) {
        pendingExplorerViewport = {
          top: lastExplorerViewport.top,
          left: lastExplorerViewport.left,
        };
        scheduleAttach(50);
      }
    });
    nativeObserver.observe(document.body, { childList: true, subtree: true });
  }

  function addEditorEvent(eventName, handler) {
    if (RED.events && typeof RED.events.on === "function") {
      RED.events.on(eventName, handler);
      editorEventHandlers.push({ eventName: eventName, handler: handler });
    }
  }

  function initEvents() {
    [
      "flows:loaded",
      "flows:add",
      "flows:remove",
      "flows:change",
      "flows:reorder",
      "subflows:add",
      "subflows:remove",
      "subflows:change",
      "workspace:clear",
      "projects:load",
    ].forEach(function (eventName) {
      addEditorEvent(eventName, function (event) {
        if (eventName === "flows:remove" || eventName === "subflows:remove") {
          const kind = eventName === "subflows:remove" ? "subflow" : "flow";
          const itemStore = Model.stores(folderConfig, kind).items;
          (Array.isArray(event) ? event : [event]).forEach(function (item) {
            if (item && item.id && itemStore[item.id]) {
              delete itemStore[item.id];
            }
          });
          scheduleConfigSave(true);
        }
        if (
          Date.now() < stateUpdateUntil &&
          (eventName === "flows:change" || eventName === "subflows:change")
        ) {
          setTimeout(refreshFolderStateControls, 0);
          return;
        }
        if (
          Date.now() < structureUpdateUntil &&
          ["flows:add", "flows:change", "flows:reorder"].includes(eventName)
        ) {
          return;
        }
        pendingExplorerViewport = {
          top: lastExplorerViewport.top,
          left: lastExplorerViewport.left,
        };
        scheduleAttach(
          eventName === "workspace:clear" || eventName === "projects:load"
            ? 120
            : 20,
        );
      });
    });
    addEditorEvent("deploy", function () {
      if (configSaveTimer) {
        saveConfigNow();
      }
    });
  }

  function closeMenus() {
    if (menuBindTimer) {
      clearTimeout(menuBindTimer);
      menuBindTimer = null;
    }
    $(".folders-native-menu").remove();
    $(document).off("mousedown.folders-native-menu");
  }

  function positionMenu(menu, event) {
    menu.css({ left: event.pageX, top: event.pageY });
    menuBindTimer = setTimeout(function () {
      menuBindTimer = null;
      if (!started) {
        return;
      }
      const rect = menu[0].getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.css("left", Math.max(4, event.pageX - rect.width));
      }
      if (rect.bottom > window.innerHeight) {
        menu.css("top", Math.max(4, event.pageY - rect.height));
      }
      $(document).on("mousedown.folders-native-menu", function (outsideEvent) {
        if (!$(outsideEvent.target).closest(menu).length) {
          closeMenus();
        }
      });
    }, 0);
  }

  function createMenu(event) {
    closeMenus();
    const menu = $("<div>", {
      class: "folders-native-menu",
      role: "menu",
    }).appendTo("body");
    positionMenu(menu, event);
    return menu;
  }

  function addMenuItem(menu, label, icon, handler, danger) {
    return $("<button>", {
      type: "button",
      class: danger ? "folders-native-menu-danger" : "",
      role: "menuitem",
    })
      .append($("<i>", { class: icon }))
      .append($("<span>", { text: label }))
      .appendTo(menu)
      .on("click", function (event) {
        event.preventDefault();
        closeMenus();
        handler();
      });
  }

  function openFolderMenu(event, kind, path) {
    const menu = createMenu(event);
    if (selectedKeys.size <= 1) {
      addMenuItem(menu, "New folder", "fa fa-folder", function () {
        createFolderAt(path);
      });
      addMenuItem(
        menu,
        "New flow",
        "red-ui-icons red-ui-icons-flow",
        function () {
          createFlowAt(path);
        },
      );
      addMenuItem(menu, "Rename", "fa fa-pencil", function () {
        const row = native.tree
          .find(".folders-native-folder-row")
          .filter(function () {
            return (
              Model.normalisePath($(this).attr("data-folder-path") || "") ===
              Model.normalisePath(path)
            );
          })
          .first();
        const item = treeItemFromLabel(row.closest(".red-ui-treeList-label"));
        if (item) {
          startInlineFolderRename($(item.element), {
            path: item.folderPath,
            name: Model.baseName(item.folderPath),
          });
        }
      });
    }
    addMenuItem(menu, "Appearance", "fa fa-tint", function () {
      openAppearanceDialog(appearanceTargetsFromSelection());
    });
    $("<div>", { class: "folders-native-menu-separator" }).appendTo(menu);
    addMenuItem(
      menu,
      "Delete",
      "fa fa-trash",
      function () {
        openRemoveFolderDialog(kind, path);
      },
      true,
    );
  }

  function openItemMenu(event, item, kind) {
    if (kind !== "flow") {
      return;
    }
    const menu = createMenu(event);
    const meta = nativeItemMeta(kind, item.id) || {};
    if (selectedKeys.size <= 1) {
      addMenuItem(menu, "New folder", "fa fa-folder", function () {
        createFolderAt(meta.path || "");
      });
      addMenuItem(
        menu,
        "New flow",
        "red-ui-icons red-ui-icons-flow",
        function () {
          createFlowAt(meta.path || "");
        },
      );
      addMenuItem(menu, "Rename", "fa fa-pencil", function () {
        startInlineItemRename(item, kind);
      });
    }
    addMenuItem(menu, "Appearance", "fa fa-tint", function () {
      openAppearanceDialog(appearanceTargetsFromSelection());
    });
    $("<div>", { class: "folders-native-menu-separator" }).appendTo(menu);
    addMenuItem(menu, "Delete", "fa fa-trash", deleteSelectedItem, true);
  }

  function destroyDialog(dialog) {
    dialog.dialog("destroy").remove();
  }

  function moveCombinedFolder(path, newParent, newName) {
    const oldPath = Model.normalisePath(path);
    let nextConfig = folderConfig;
    let newPath = oldPath;
    ["flow", "subflow"].forEach(function (kind) {
      if (!Model.stores(nextConfig, kind).folders[oldPath]) {
        return;
      }
      const moved = Model.moveFolder(
        nextConfig,
        kind,
        oldPath,
        newParent,
        newName,
      );
      nextConfig = moved.config;
      newPath = moved.path;
    });
    folderConfig = nextConfig;
    if (newPath !== oldPath) {
      Array.from(collapsedFolders).forEach(function (key) {
        const prefix = "flow:" + oldPath;
        if (key === prefix || key.indexOf(prefix + "/") === 0) {
          collapsedFolders.delete(key);
          collapsedFolders.add("flow:" + newPath + key.slice(prefix.length));
        }
      });
      Array.from(selectedKeys).forEach(function (key) {
        const prefix = "folder:" + oldPath;
        if (key === prefix || key.indexOf(prefix + "/") === 0) {
          const remapped = "folder:" + newPath + key.slice(prefix.length);
          selectedKeys.delete(key);
          selectedKeys.add(remapped);
          if (primarySelectionKey === key) {
            primarySelectionKey = remapped;
          }
          if (selectionAnchorKey === key) {
            selectionAnchorKey = remapped;
          }
        }
      });
      saveLocalState();
    }
    return newPath;
  }

  function removeCombinedFolder(path) {
    let nextConfig = folderConfig;
    ["flow", "subflow"].forEach(function (kind) {
      if (Model.stores(nextConfig, kind).folders[path]) {
        nextConfig = Model.removeFolder(nextConfig, kind, path);
      }
    });
    folderConfig = nextConfig;
  }

  function openAppearanceDialog(target) {
    const targets = (Array.isArray(target) ? target : [target]).filter(
      function (entry) {
        return (
          entry &&
          (entry.type === "folder" ||
            (entry.type === "item" && entry.kind === "flow"))
        );
      },
    );
    if (!targets.length) {
      return;
    }
    const records = targets
      .map(function (entry) {
        const stores = Model.stores(folderConfig, entry.kind);
        const record =
          entry.type === "folder"
            ? stores.folders[entry.path]
            : stores.items[entry.id];
        return record ? { target: entry, record: record } : null;
      })
      .filter(Boolean);
    if (!records.length) {
      return;
    }
    const firstTarget = records[0].target;
    const record = records[0].record;
    const foldersOnly = records.every(function (entry) {
      return entry.target.type === "folder";
    });
    const dialog = $("<div>", {
      class: "folders-native-dialog folders-style-dialog",
    }).appendTo("body");
    const defaultIcon =
      firstTarget.type === "folder"
        ? Model.DEFAULT_FOLDER_ICON
        : DEFAULT_FLOW_ICON;
    const colors = [
      "",
      "#4c566a",
      "#5e81ac",
      "#81a1c1",
      "#88c0d0",
      "#8fbcbb",
      "#a3be8c",
      "#b5bd68",
      "#ebcb8b",
      "#d08770",
      "#bf616a",
      "#b48ead",
    ];
    const icons = foldersOnly
      ? [
          "fa fa-folder",
          "fa fa-folder-o",
          "fa fa-folder-open-o",
          "fa fa-archive",
          "fa fa-cubes",
          "fa fa-sitemap",
          "fa fa-home",
          "fa fa-building-o",
          "fa fa-industry",
          "fa fa-server",
          "fa fa-database",
          "fa fa-cog",
        ]
      : [
          "red-ui-icons red-ui-icons-flow",
          "fa fa-file-o",
          "fa fa-code",
          "fa fa-random",
          "fa fa-microchip",
          "fa fa-dashboard",
          "fa fa-thermometer-half",
          "fa fa-snowflake-o",
          "fa fa-fire",
          "fa fa-exchange",
          "fa fa-line-chart",
          "fa fa-cog",
        ];
    const colorRow = $("<div>", {
      class: "folders-native-form-row folders-style-row",
    }).appendTo(dialog);
    $("<label>", { text: "Colour" }).appendTo(colorRow);
    const colorGrid = $("<div>", { class: "folders-style-grid" }).appendTo(
      colorRow,
    );
    const colorInput = $("<input>", {
      type: "text",
      value: record.color || "",
      placeholder: "#HEX",
      "aria-label": "Custom colour",
    }).appendTo(colorRow);
    colors.forEach(function (color) {
      const choice = $("<button>", {
        type: "button",
        class:
          "folders-color-choice" +
          ((record.color || "") === color ? " selected" : ""),
        title: color || "Default",
        "aria-label": color || "Default colour",
      })
        .css(
          "background",
          color ||
            "linear-gradient(45deg,#fff 0,#fff 45%,#ccc 45%,#ccc 55%,#fff 55%,#fff 100%)",
        )
        .appendTo(colorGrid)
        .on("click", function () {
          colorGrid.find(".folders-color-choice").removeClass("selected");
          choice.addClass("selected");
          colorInput.val(color);
        });
    });
    const iconInput = $("<input>", {
      type: "text",
      value: record.icon || defaultIcon,
      placeholder: defaultIcon,
      "aria-label": "Custom icon",
    });
    const iconRow = $("<div>", {
      class: "folders-native-form-row folders-style-row",
    }).appendTo(dialog);
    $("<label>", { text: "Icon" }).appendTo(iconRow);
    const iconGrid = $("<div>", { class: "folders-style-grid" }).appendTo(
      iconRow,
    );
    icons.forEach(function (icon) {
      const choice = $("<button>", {
        type: "button",
        class:
          "folders-icon-choice" +
          ((record.icon || defaultIcon) === icon ? " selected" : ""),
        title: icon,
        "aria-label": icon,
      })
        .append($("<i>", { class: icon }))
        .appendTo(iconGrid)
        .on("click", function () {
          iconGrid.find(".folders-icon-choice").removeClass("selected");
          choice.addClass("selected");
          iconInput.val(icon);
        });
    });
    iconInput.appendTo(iconRow);
    dialog.dialog({
      modal: true,
      width: 430,
      title:
        records.length === 1
          ? "Appearance"
          : "Appearance - " + records.length + " items",
      buttons: [
        {
          text: "Cancel",
          click: function () {
            destroyDialog(dialog);
          },
        },
        {
          text: "Apply",
          class: "primary",
          click: function () {
            const icon = Model.normaliseIcon(iconInput.val(), defaultIcon);
            const rawColor = String(colorInput.val() || "").trim();
            const color = Model.normaliseColor(rawColor);
            if (rawColor && !color) {
              notify("Enter a valid CSS colour.", "error");
              return;
            }
            const updatedAt = new Date().toISOString();
            records.forEach(function (entry) {
              entry.record.icon = icon;
              entry.record.color = color;
              entry.record.updatedAt = updatedAt;
            });
            scheduleConfigSave(true);
            records.forEach(function (entry) {
              const target = entry.target;
              const key =
                target.type === "folder"
                  ? "folder:" + Model.normalisePath(target.path)
                  : target.kind + ":" + target.id;
              const item = itemForSelectionKey(key);
              if (target.type === "folder") {
                styleFolderItem(item);
              } else {
                styleNativeItem(item, target.kind);
              }
            });
            applySelectionToTree();
            updateFooterButtons();
            destroyDialog(dialog);
          },
        },
      ],
      close: function () {
        dialog.remove();
      },
    });
  }

  function confirmDialog(title, message, actionText, action) {
    const dialog = $("<div>", { class: "folders-native-dialog" }).appendTo(
      "body",
    );
    if (message && message.jquery) {
      dialog.append(message);
    } else {
      dialog.append($("<p>", { text: message }));
    }
    dialog.dialog({
      modal: true,
      width: 470,
      title: title,
      buttons: [
        {
          text: "Cancel",
          click: function () {
            destroyDialog(dialog);
          },
        },
        {
          text: actionText,
          class: "folders-native-dialog-danger",
          click: function () {
            action();
            destroyDialog(dialog);
          },
        },
      ],
      close: function () {
        dialog.remove();
      },
    });
  }

  function openRemoveFolderDialog(kind, path) {
    const key = "folder:" + Model.normalisePath(path);
    const eligible = selectedKeys.has(key)
      ? Array.from(selectedKeys).filter(function (selectionKey) {
          const entry = selectionEntry(selectionKey);
          return entry && (entry.type === "folder" || entry.type === "flow");
        })
      : [key];
    openDeletionPlan(buildDeletionPlan(eligible.length ? eligible : [key]));
  }

  function restoreNativeRoots() {
    if (!native.flowRoot || !native.subflowRoot) {
      return;
    }
    const roots = [native.flowRoot, native.subflowRoot];
    const flowItems = collectUniqueItems(roots, "flow");
    const subflowItems = collectUniqueItems(roots, "subflow");
    flowItems.forEach(function (item) {
      restoreNativeItem(item, "flow");
    });
    subflowItems.forEach(function (item) {
      restoreNativeItem(item, "subflow");
    });
    flowItems.concat(subflowItems).forEach(function (item) {
      removeTreeItem(item, true);
    });
    roots.forEach(function (root) {
      (root.children || []).slice().forEach(function (item) {
        if (item.__foldersFolder) {
          removePluginFolder(item);
        }
      });
    });
    const order = {};
    try {
      (RED.nodes.getWorkspaceOrder() || []).forEach(function (id, index) {
        order[id] = index;
      });
    } catch (err) {}
    flowItems.sort(function (left, right) {
      return (order[left.id] || 0) - (order[right.id] || 0);
    });
    subflowItems.sort(function (left, right) {
      return itemLabel(findSubflow(left.id)).localeCompare(
        itemLabel(findSubflow(right.id)),
      );
    });
    flowItems.forEach(function (item) {
      native.flowRoot.treeList.addChild(item);
    });
    subflowItems.forEach(function (item) {
      native.subflowRoot.treeList.addChild(item);
    });
  }

  function detachUiOnly() {
    closeMenus();
    closeHeaderMenus();
    if (scrollTrackingElement && scrollTrackingHandler) {
      scrollTrackingElement.removeEventListener(
        "scroll",
        scrollTrackingHandler,
        true,
      );
      ["wheel", "touchstart", "pointerdown", "keydown"].forEach(
        function (eventName) {
          scrollTrackingElement.removeEventListener(
            eventName,
            scrollIntentHandler,
            true,
          );
        },
      );
    }
    scrollTrackingElement = null;
    scrollTrackingHandler = null;
    scrollIntentHandler = null;
    if (native.tree) {
      if (treeClickCapture && native.tree[0]) {
        native.tree[0].removeEventListener("click", treeClickCapture, true);
        native.tree[0].removeEventListener("dblclick", treeClickCapture, true);
      }
      treeClickCapture = null;
      native.tree
        .off(".folders-native-node")
        .off(".folders-native-info")
        .off(".folders-native-root")
        .off(".folders-native-rename")
        .off(".folders-native-footer")
        .off(".folders-native-indent");
      native.tree
        .find(".red-ui-treeList-label.folders-multi-selected")
        .removeClass("folders-multi-selected");
    }
    if (native.controls) {
      native.controls.remove();
    }
    if (native.footer) {
      native.footer.remove();
    }
    if (native.headerToggle) {
      native.headerToggle.remove();
    }
    if (native.searchOptions && native.searchOptions.length) {
      native.searchOptions.appendTo(
        native.searchToolbar.find(".red-ui-searchBox-container").first(),
      );
      native.searchToolbar
        .find(".red-ui-searchBox-container")
        .addClass("red-ui-searchBox-has-options");
    }
    if (native.searchToolbar) {
      native.searchToolbar.show();
    }
    setRootListItemVisible(native.flowRoot, true);
    setRootListItemVisible(native.subflowRoot, true);
    setRootListItemVisible(native.configRoot, true);
    if (native.flowRoot && native.flowRoot.treeList.container) {
      native.flowRoot.treeList.container
        .closest("li")
        .removeClass("folders-native-flow-root-item");
    }
    if (native.subflowRoot && native.subflowRoot.treeList.container) {
      native.subflowRoot.treeList.container
        .closest("li")
        .removeClass("folders-native-subflow-root-item");
    }
    if (native.configRoot && native.configRoot.treeList.container) {
      native.configRoot.treeList.container
        .closest("li")
        .removeClass("folders-native-config-root-item");
    }
    $(".folders-native-info-panel").remove();
    if (native.flowRoot && native.flowRoot.treeList.container) {
      native.flowRoot.treeList.container.removeClass(
        "folders-native-combined-root",
      );
    }
    if (native.subflowRoot && native.subflowRoot.treeList.container) {
      native.subflowRoot.treeList.container.removeClass(
        "folders-native-subflow-source-root",
      );
    }
    if (
      native.configRoot &&
      native.configRoot.treeList &&
      native.configRoot.treeList.container
    ) {
      native.configRoot.treeList.container.removeClass(
        "folders-native-config-root",
      );
      (native.configRoot.children || []).forEach(function (typeGroup) {
        (typeGroup.children || []).forEach(function (configItem) {
          normaliseVisibleIndent(configItem, 0);
        });
        if (typeGroup.treeList && typeGroup.treeList.container) {
          typeGroup.treeList.container.removeClass(
            "folders-native-config-type",
          );
        }
      });
    }
    if (native.ownedChildren && native.ownedChildren.length) {
      native.ownedChildren.removeClass("folders-native-owned");
    }
    if (native.outline) {
      native.outline.removeClass(
        "folders-native-explorer folders-native-configuration-active folders-explorer",
      );
    }
    native.controls = null;
    native.toolbar = null;
    native.footer = null;
    native.bannerTools = null;
    native.headerToggle = null;
    native.searchToolbar = null;
    native.searchOptions = null;
    native.filterButton = null;
    native.sortButton = null;
    native.sortSelect = null;
    native.sortDirectionButton = null;
    native.footerStyleButton = null;
    native.footerDeleteButton = null;
    native.ownedChildren = $();
    $(document).off(".folders-header-menu");
    $(document).off(".folders-native-rename");
  }

  function start() {
    if (started) {
      return;
    }
    started = true;
    loadLocalState();
    folderConfig = readStoredConfig();
    if (loadedFromLocalBackup) {
      setTimeout(function () {
        if (started) {
          saveConfigNow(true);
        }
      }, 0);
    }
    initEvents();
    initObserver();
    scheduleAttach(0);
    healthTimer = setInterval(function () {
      if (
        !native.tree ||
        !native.tree.length ||
        !$.contains(document, native.tree[0])
      ) {
        scheduleAttach(0);
      }
    }, 1500);
    try {
      RED.actions.add("folders:show", function () {
        RED.actions.invoke("core:show-explorer-tab");
        switchMode("explorer");
      });
    } catch (err) {}
  }

  function stop() {
    if (!started) {
      return;
    }
    started = false;
    if (configSaveTimer) {
      saveConfigNow();
    }
    [
      attachTimer,
      reconcileTimer,
      decorateTimer,
      menuBindTimer,
      storageRetryTimer,
    ].forEach(function (timer) {
      if (timer) {
        clearTimeout(timer);
      }
    });
    attachTimer = null;
    reconcileTimer = null;
    decorateTimer = null;
    menuBindTimer = null;
    storageRetryTimer = null;
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
    if (nativeObserver) {
      nativeObserver.disconnect();
      nativeObserver = null;
    }
    deferredExpansionTimers.forEach(function (timers) {
      timers.forEach(clearTimeout);
    });
    deferredExpansionTimers.clear();
    try {
      restoreNativeRoots();
    } catch (err) {
      console.warn(
        "[folders] Could not flatten native Explorer while unloading.",
        err,
      );
    }
    detachUiOnly();
    if (RED.events && typeof RED.events.off === "function") {
      editorEventHandlers.forEach(function (entry) {
        RED.events.off(entry.eventName, entry.handler);
      });
    }
    editorEventHandlers.length = 0;
    $(document).off(".folders-native-menu");
    try {
      RED.actions.remove("folders:show");
    } catch (err) {}
    native.outline = null;
    native.tree = null;
    native.flowRoot = null;
    native.subflowRoot = null;
    native.configRoot = null;
  }

  // Test hooks are opt-in and never created in the Node-RED editor.
  if (window.__NODE_RED_FOLDERS_TEST_HOOKS__) {
    Object.assign(window.__NODE_RED_FOLDERS_TEST_HOOKS__, {
      desiredExpansionState: desiredExpansionState,
      getConfig: function () {
        return Model.normaliseConfig(folderConfig);
      },
      nextExpansionState: nextExpansionState,
      inlineRenameKeyAction: inlineRenameKeyAction,
      bindInlineRenameKeyboard: bindInlineRenameKeyboard,
      flowStatesForDestination: flowStatesForDestination,
      isCustomFlowIcon: isCustomFlowIcon,
      selectionRangeKeys: selectionRangeKeys,
      verticalRevealScrollTop: verticalRevealScrollTop,
      restoreNativeItem: restoreNativeItem,
      setItemExpandedAnimated: setItemExpandedAnimated,
      setItemExpandedInstant: setItemExpandedInstant,
      setConfig: function (value) {
        folderConfig = Model.normaliseConfig(value);
      },
      syncKnownItems: syncKnownItems,
    });
  }

  if (
    window.RED &&
    RED.plugins &&
    typeof RED.plugins.registerPlugin === "function"
  ) {
    RED.plugins.registerPlugin(PLUGIN_ID, {
      type: "folders",
      name: "Folders",
      onadd: start,
      onremove: stop,
    });
  } else {
    $(start);
  }
})();
