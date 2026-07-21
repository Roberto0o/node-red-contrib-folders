# Folders

`node-red-contrib-folders`

Folders adds a folder hierarchy to Node-RED's built-in Explorer for organising flows and subflows. It keeps the native Explorer rows and controls while adding batch actions, appearance settings, sorting, filtering, and a dedicated view for global configuration nodes.

## Features

- Organise flows and subflows together in nested folders.
<img width="201" height="423" alt="folders" src="https://github.com/user-attachments/assets/62510b46-cd2a-4ad7-9e1d-5ad4c1fc3572" />

- Create, rename, move, multi-select, and drag folders, flows, and subflows.
- Search the active view and filter or sort workspace items by name, date, type, and flow state.
- Apply custom colours and icons to folders and flows.
<img width="296.5" height="305" alt="style" src="https://github.com/user-attachments/assets/623cb4ad-e8c0-4a67-928b-2a14d5edc2ec" />

- Hide, disable, or lock all supported items inside a folder, including nested folders.
- Hide individual subflows from the Explorer.
- Delete folders recursively with a clear warning when contained flows or subflows have nodes.
- Switch between the flow hierarchy and Node-RED's global configuration nodes from the Explorer header.
- Store folder structure, state defaults, and appearance metadata with the flow configuration.

## Behaviour

A single click selects a folder, flow, subflow, or node. Selecting a flow or subflow also opens its workspace; double-clicking opens its editor or the selected node's edit dialog.

Use <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>-click to add or remove individual items from a selection. Use <kbd>Shift</kbd>-click for a visible range, or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>-click to extend the current selection. Supported appearance, state, delete, and drag actions apply to the complete selection.

Press <kbd>F2</kbd> to rename the selected item in place. <kbd>Enter</kbd> saves, <kbd>Escape</kbd> cancels, and the normal cursor keys remain available while editing.

New folders and flows are created in the selected directory and receive collision-safe names such as **New folder 2** or **New flow 2**. A new row stays where it is when already fully visible; otherwise, its parent path opens and the Explorer centres it as far as the available scroll range permits.

Moving a flow or folder into another folder applies that destination's stored hidden, disabled, and locked defaults. Newly created flows always start enabled. Dragging an item onto empty Explorer space moves it to the root.

Folder data is stored in the global environment variable named `folders`. Collapsed state, sorting, filtering, and the selected Explorer view are browser preferences.

## Requirements

- Node-RED 5.0 or newer
- Node.js 22.9 or newer

## Contact

Found a bug, have a suggestion, or want to discuss a plugin?

- Start a topic on the [Node-RED Forum](https://discourse.nodered.org/) and tag me.
- Join the [Discord community](https://discord.gg/cheJvPZN).

## License

Licensed under the [MIT License](LICENSE).
