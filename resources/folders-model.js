(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.NodeRedFoldersModel = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_FOLDER_ICON = "fa fa-folder";
  const RESERVED_PATH_SEGMENTS = new Set([
    "__proto__",
    "prototype",
    "constructor",
  ]);

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function normalisePath(value) {
    if (value === undefined || value === null) {
      return "";
    }
    const parts = String(value)
      .trim()
      .replace(/\\+/g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .map(function (part) {
        return part.trim();
      })
      .filter(function (part) {
        return part && part !== "." && part !== "..";
      });
    if (
      parts.some(function (part) {
        return RESERVED_PATH_SEGMENTS.has(part.toLowerCase());
      })
    ) {
      return "";
    }
    return parts.join("/");
  }

  function storedPath(value) {
    const path = normalisePath(value);
    return path ? "/" + path : "/";
  }

  function parentPath(value) {
    const parts = normalisePath(value).split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
  }

  function baseName(value) {
    const parts = normalisePath(value).split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }

  function normaliseIcon(value, fallback) {
    const icon = String(value || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!icon) {
      return fallback || "";
    }
    return /^[a-z0-9_ -]{1,120}$/i.test(icon) ? icon : fallback || "";
  }

  function normaliseColor(value) {
    const color = String(value || "").trim();
    if (!color) {
      return "";
    }
    if (/^#[0-9a-f]{3,8}$/i.test(color)) {
      return color;
    }
    if (/^(?:rgb|hsl)a?\([0-9.,%\s+-]+\)$/i.test(color)) {
      return color;
    }
    if (/^[a-z]{1,32}$/i.test(color)) {
      return color;
    }
    return "";
  }

  function emptyConfig(updatedAt) {
    return {
      version: 1,
      folders: {},
      flows: {},
      subflowFolders: {},
      subflows: {},
      updatedAt: updatedAt || "",
    };
  }

  function folderRecord(path, input) {
    const cleanPath = normalisePath(path);
    const source = isObject(input) ? input : {};
    const stamp = source.updatedAt || nowIso();
    return {
      path: storedPath(cleanPath),
      name: String(source.name || baseName(cleanPath)),
      parent: storedPath(parentPath(cleanPath)),
      icon: normaliseIcon(source.icon, DEFAULT_FOLDER_ICON),
      color: normaliseColor(source.color),
      hidden: !!source.hidden,
      disabled: !!source.disabled,
      locked: !!source.locked,
      createdAt: source.createdAt || stamp,
      updatedAt: stamp,
      folders: Array.isArray(source.folders) ? source.folders.slice() : [],
      files: Array.isArray(source.files) ? source.files.slice() : [],
    };
  }

  function itemRecord(id, input) {
    const source =
      typeof input === "string"
        ? { path: input }
        : isObject(input)
          ? input
          : {};
    const stamp = source.updatedAt || nowIso();
    return {
      id: String(id),
      name: String(source.name || ""),
      path: storedPath(source.path || source.dir || ""),
      icon: normaliseIcon(source.icon, ""),
      color: normaliseColor(source.color),
      hidden: !!source.hidden,
      createdAt: source.createdAt || stamp,
      updatedAt: stamp,
    };
  }

  function normaliseConfig(value) {
    const source = isObject(value) ? value : {};
    const clean = emptyConfig(source.updatedAt || "");
    const sourceFolders = isObject(source.folders) ? source.folders : {};
    const sourceFlows = isObject(source.flows)
      ? source.flows
      : isObject(source.flowPaths)
        ? source.flowPaths
        : {};
    const sourceSubflowFolders = isObject(source.subflowFolders)
      ? source.subflowFolders
      : {};
    const sourceSubflows = isObject(source.subflows) ? source.subflows : {};

    Object.keys(sourceFolders).forEach(function (key) {
      const input = isObject(sourceFolders[key]) ? sourceFolders[key] : {};
      const path = normalisePath(input.path || key);
      if (path) {
        clean.folders[path] = folderRecord(path, input);
      }
    });
    Object.keys(sourceFlows).forEach(function (id) {
      if (id && !RESERVED_PATH_SEGMENTS.has(String(id).toLowerCase())) {
        clean.flows[id] = itemRecord(id, sourceFlows[id]);
      }
    });
    Object.keys(sourceSubflowFolders).forEach(function (key) {
      const input = isObject(sourceSubflowFolders[key])
        ? sourceSubflowFolders[key]
        : {};
      const path = normalisePath(input.path || key);
      if (path) {
        clean.subflowFolders[path] = folderRecord(path, input);
      }
    });
    Object.keys(sourceSubflows).forEach(function (id) {
      if (id && !RESERVED_PATH_SEGMENTS.has(String(id).toLowerCase())) {
        clean.subflows[id] = itemRecord(id, sourceSubflows[id]);
      }
    });
    return clean;
  }

  function stores(config, kind) {
    return kind === "subflow"
      ? { folders: config.subflowFolders, items: config.subflows }
      : { folders: config.folders, items: config.flows };
  }

  function ensureFolder(config, kind, value, patch) {
    const path = normalisePath(value);
    if (!path) {
      return null;
    }
    const target = stores(config, kind).folders;
    const parts = path.split("/");
    let current = "";
    parts.forEach(function (part, index) {
      current = current ? current + "/" + part : part;
      if (!target[current]) {
        target[current] = folderRecord(current, {});
      }
      if (index === parts.length - 1 && isObject(patch)) {
        target[current] = folderRecord(
          current,
          Object.assign({}, target[current], patch),
        );
      }
    });
    return target[path];
  }

  function setItemPath(config, kind, id, value, name) {
    const target = stores(config, kind);
    const path = normalisePath(value);
    if (path) {
      ensureFolder(config, kind, path);
    }
    const existing = target.items[id] || itemRecord(id, {});
    target.items[id] = itemRecord(
      id,
      Object.assign({}, existing, {
        name: name === undefined ? existing.name : name,
        path: storedPath(path),
        updatedAt: nowIso(),
      }),
    );
    return target.items[id];
  }

  function replacePrefix(value, oldPath, newPath) {
    const path = normalisePath(value);
    if (path === oldPath) {
      return newPath;
    }
    if (path.indexOf(oldPath + "/") === 0) {
      return normalisePath(newPath + path.slice(oldPath.length));
    }
    return path;
  }

  function assertFolderMove(target, oldPath, newPath) {
    if (!oldPath || !target[oldPath]) {
      throw new Error("Folder not found.");
    }
    if (!newPath) {
      throw new Error("A folder name is required.");
    }
    if (newPath === oldPath || newPath.indexOf(oldPath + "/") === 0) {
      if (newPath !== oldPath) {
        throw new Error("A folder cannot be moved inside itself.");
      }
      return;
    }
    const movingPaths = Object.keys(target).filter(function (path) {
      return path === oldPath || path.indexOf(oldPath + "/") === 0;
    });
    const movingSet = new Set(movingPaths);
    const destinations = new Set();
    movingPaths.forEach(function (path) {
      const mapped = replacePrefix(path, oldPath, newPath);
      if (destinations.has(mapped)) {
        throw new Error(
          "Moving this folder would merge two folders with the same name.",
        );
      }
      destinations.add(mapped);
      if (target[mapped] && !movingSet.has(mapped)) {
        throw new Error("A folder already exists at that location.");
      }
    });
  }

  function moveFolder(configValue, kind, value, newParentValue, newNameValue) {
    const config = normaliseConfig(configValue);
    const target = stores(config, kind);
    const oldPath = normalisePath(value);
    const newParent = normalisePath(newParentValue);
    const newName = normalisePath(newNameValue);
    if (!newName || newName.indexOf("/") !== -1) {
      throw new Error("Folder names cannot contain slashes.");
    }
    const newPath = normalisePath((newParent ? newParent + "/" : "") + newName);
    assertFolderMove(target.folders, oldPath, newPath);
    if (newPath === oldPath) {
      return { config: config, path: oldPath };
    }

    const movedFolders = {};
    Object.keys(target.folders).forEach(function (path) {
      if (path === oldPath || path.indexOf(oldPath + "/") === 0) {
        const mapped = replacePrefix(path, oldPath, newPath);
        const record = target.folders[path];
        movedFolders[mapped] = folderRecord(
          mapped,
          Object.assign({}, record, {
            name: path === oldPath ? newName : record.name,
            updatedAt: nowIso(),
          }),
        );
        delete target.folders[path];
      }
    });
    Object.assign(target.folders, movedFolders);
    Object.keys(target.items).forEach(function (id) {
      const path = normalisePath(target.items[id].path);
      const mapped = replacePrefix(path, oldPath, newPath);
      if (mapped !== path) {
        target.items[id] = itemRecord(
          id,
          Object.assign({}, target.items[id], {
            path: storedPath(mapped),
            updatedAt: nowIso(),
          }),
        );
      }
    });
    return { config: config, path: newPath };
  }

  function removeFolder(configValue, kind, value) {
    const config = normaliseConfig(configValue);
    const target = stores(config, kind);
    const oldPath = normalisePath(value);
    if (!oldPath || !target.folders[oldPath]) {
      throw new Error("Folder not found.");
    }
    const destination = parentPath(oldPath);
    const descendants = Object.keys(target.folders).filter(function (path) {
      return path.indexOf(oldPath + "/") === 0;
    });
    const remap = {};
    descendants.forEach(function (path) {
      const suffix = path.slice(oldPath.length + 1);
      const mapped = normalisePath(
        (destination ? destination + "/" : "") + suffix,
      );
      if (
        target.folders[mapped] &&
        mapped !== path &&
        mapped.indexOf(oldPath + "/") !== 0
      ) {
        throw new Error(
          "Removing this folder would merge two folders with the same name.",
        );
      }
      remap[path] = mapped;
    });
    delete target.folders[oldPath];
    descendants.forEach(function (path) {
      const mapped = remap[path];
      target.folders[mapped] = folderRecord(
        mapped,
        Object.assign({}, target.folders[path], { updatedAt: nowIso() }),
      );
      delete target.folders[path];
    });
    Object.keys(target.items).forEach(function (id) {
      const path = normalisePath(target.items[id].path);
      const mapped = replacePrefix(path, oldPath, destination);
      if (mapped !== path) {
        target.items[id] = itemRecord(
          id,
          Object.assign({}, target.items[id], {
            path: storedPath(mapped),
            updatedAt: nowIso(),
          }),
        );
      }
    });
    return config;
  }

  function rebuildIndexes(configValue) {
    const config = normaliseConfig(configValue);
    ["flow", "subflow"].forEach(function (kind) {
      const target = stores(config, kind);
      Object.keys(target.folders).forEach(function (path) {
        const parent = parentPath(path);
        if (parent) {
          ensureFolder(config, kind, parent);
        }
      });
      Object.keys(target.items).forEach(function (id) {
        const path = normalisePath(target.items[id].path);
        if (path) {
          ensureFolder(config, kind, path);
        }
      });
      Object.keys(target.folders).forEach(function (path) {
        target.folders[path].files = [];
        target.folders[path].folders = [];
        target.folders[path].parent = storedPath(parentPath(path));
      });
      Object.keys(target.folders).forEach(function (path) {
        const parent = parentPath(path);
        if (parent && target.folders[parent]) {
          target.folders[parent].folders.push(storedPath(path));
        }
      });
      Object.keys(target.items).forEach(function (id) {
        const path = normalisePath(target.items[id].path);
        if (path && target.folders[path]) {
          target.folders[path].files.push(id);
        }
      });
      Object.keys(target.folders).forEach(function (path) {
        target.folders[path].files.sort();
        target.folders[path].folders.sort();
      });
    });
    return config;
  }

  function buildFolderTree(configValue, kind, itemsValue) {
    const config = normaliseConfig(configValue);
    const target = stores(config, kind);
    const nodes = {};
    Object.keys(target.folders).forEach(function (path) {
      nodes[path] = {
        path: path,
        name: target.folders[path].name || baseName(path),
        meta: target.folders[path],
        folders: [],
        items: [],
      };
    });
    const roots = [];
    Object.keys(nodes).forEach(function (path) {
      const parent = parentPath(path);
      if (parent && nodes[parent]) {
        nodes[parent].folders.push(nodes[path]);
      } else {
        roots.push(nodes[path]);
      }
    });
    const rootItems = [];
    (Array.isArray(itemsValue) ? itemsValue : []).forEach(function (item) {
      const id = item && item.id;
      const path =
        id && target.items[id] ? normalisePath(target.items[id].path) : "";
      if (path && nodes[path]) {
        nodes[path].items.push(item);
      } else {
        rootItems.push(item);
      }
    });
    function sortNode(node) {
      node.folders.sort(function (a, b) {
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
      node.folders.forEach(sortNode);
    }
    roots.sort(function (a, b) {
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    roots.forEach(sortNode);
    return { folders: roots, rootItems: rootItems };
  }

  function makeFolderId(kind, path) {
    return (
      "__folders__" + kind + "__" + encodeURIComponent(normalisePath(path))
    );
  }

  function toStorageConfig(configValue) {
    const config = rebuildIndexes(configValue);
    const output = emptyConfig(nowIso());
    ["flow", "subflow"].forEach(function (kind) {
      const source = stores(config, kind);
      const destination = stores(output, kind);
      Object.keys(source.folders)
        .sort()
        .forEach(function (path) {
          destination.folders[storedPath(path)] = Object.assign(
            {},
            source.folders[path],
            {
              path: storedPath(path),
            },
          );
        });
      Object.keys(source.items)
        .sort()
        .forEach(function (id) {
          destination.items[id] = Object.assign({}, source.items[id], {
            path: storedPath(source.items[id].path),
          });
        });
    });
    return output;
  }

  return {
    DEFAULT_FOLDER_ICON: DEFAULT_FOLDER_ICON,
    baseName: baseName,
    buildFolderTree: buildFolderTree,
    emptyConfig: emptyConfig,
    ensureFolder: ensureFolder,
    makeFolderId: makeFolderId,
    moveFolder: moveFolder,
    normaliseColor: normaliseColor,
    normaliseConfig: normaliseConfig,
    normaliseIcon: normaliseIcon,
    normalisePath: normalisePath,
    parentPath: parentPath,
    rebuildIndexes: rebuildIndexes,
    removeFolder: removeFolder,
    setItemPath: setItemPath,
    storedPath: storedPath,
    stores: stores,
    toStorageConfig: toStorageConfig,
  };
});
