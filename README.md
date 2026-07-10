# node-red-contrib-folders

Version: `1.0.14`

`node-red-contrib-folders` adds a folder-based explorer to the Node-RED editor. It is intended for larger Node-RED projects where the normal flat list of flow tabs becomes hard to scan.

Folders is an editor plugin. It does not change how Node-RED runs, deploys, or stores nodes at runtime. The folder structure is visual organisation for the editor.

<img width="229" height="334" alt="folders" src="https://github.com/user-attachments/assets/5c912a87-5856-4e45-b3bc-1808bf1ad63a" />

## Features

- Browse flows and subflows in one shared workspace tree.
- Create folders, flows from the explorer.
- Move flows, subflows, and folders with drag and drop.
- Rename flows, subflows, and folders from the explorer.
- Search, filter, and sort the workspace.
- Store folder metadata created date, and updated date for sorting.
- Show additional (sub)flow information in the Node-RED information sidebar.
<img width="208" height="192" alt="info" src="https://github.com/user-attachments/assets/9dce0d51-1524-4456-9288-45bfb5adea4f" />

- Apply hide/show, enable/disable, and lock/unlock actions to flows, subflows, or whole folders.
- Style folders, flows, and subflows with selectable icons and colours.
<img width="298" height="434" alt="style" src="https://github.com/user-attachments/assets/40b41d12-9db4-47ec-8485-2b6468baff37" />

- Features mentioned above available as right-click.

Subflows use the normal flow icon by default with a small `S` badge so they remain identifiable even when a custom icon is selected.

## Storage

Project structure data is stored in a Node-RED global environment variable named:

```text
folders
```

Node-RED stores this global environment variables with the flow file, so the folder structure can be exported, backed up, etc, together with the rest of the project.

Local editor-only preferences, such as open folders and sort/filter settings, are stored in the browser local storage. These preferences are not written to `flows.json`.

## Compatibility

This package is designed for Node-RED `>=5` and Node.js `>=18.5`.

If another user opens the project without this package installed, the Node-RED project will still run normally. They simply will not see the Folders explorer or its visual organisation.

## Removing

Removing the package only removes the editor plugin. It does not delete the saved `folders` project metadata from your flow file.

To fully reset the saved folder structure, remove the `folders` global environment variable from the project.
