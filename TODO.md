# TODO status for dev-10

## Implemented

- [x] Replace the separate Folders explorer with an extension of Node-RED's native Explorer.
- [x] Relocate the actual native flow and subflow TreeList items instead of recreating their labels and controls.
- [x] Preserve native expansion into nodes and groups, workspace navigation, editing, activation buttons, and flow controls.
- [x] Delegate node deletion to Node-RED's native delete action.
- [x] Add folder hierarchy, drag and drop, rename, move, removal, icons, and colours.
- [x] Mix native flow and subflow rows directly at the workspace root without their parent dropdowns.
- [x] Put native global configuration nodes behind one banner switch, hide the outer root, and retain one visible configuration-type parent.
- [x] Restore the exact four-button `1.0.15` footer.
- [x] Restore the `1.0.15` filter, sort, and sort-direction header controls.
- [x] Remove the native search-options caret while preserving search.
- [x] Restore folder-row state and rename controls while keeping native flow/subflow rows unchanged.
- [x] Show selected folder metadata in the normal Info panel.
- [x] Preserve the global `folders` environment-variable schema and browser-only collapsed state.
- [x] Persist empty-folder state defaults and apply them to newly created or moved descendants.
- [x] Restore grouped selection, grouped drag/drop, and grouped flow-state actions.
- [x] Keep expansion state stable without queued TreeList animations during rebuilds.
- [x] Recursively delete folder contents with node-aware confirmation details.
- [x] Save explicit changes immediately and recover the latest editor hierarchy after an accidental refresh.
- [x] Retry global configuration creation until Node-RED registers the required type.
- [x] Restore controlled open/close animations without allowing queued animation lag.
- [x] Allow open/close animations to reverse cleanly while they are still running.
- [x] Let every new toggle override a pending animation, including deferred native child loading and arrow double-clicks.
- [x] Commit inline folder, flow, subflow, and node renames with Enter.
- [x] Keep cursor-navigation keys inside rename fields and let Escape cancel without saving or deleting a newly created folder.
- [x] Keep grouped appearance and deletion available for Ctrl/Cmd and Shift multi-selection while hiding single-item context actions.
- [x] Prevent configuration searches from restoring hidden root list-item spacing.
- [x] Apply appearance changes directly to affected rows instead of rebuilding the full Explorer.
- [x] Add persistent subflow hiding to row, folder-wide, inherited, and multi-selected hide/show actions.
- [x] Preserve the Explorer scroll position through native refreshes, imports, and hierarchy or appearance changes.
- [x] Apply appearance changes to every selected flow and folder at once.
- [x] Keep new-item inline rename active while native Explorer events settle.
- [x] Remove hidden root list rows from the configuration view and restore menu icon fonts.
- [x] Commit inline renames with normal or numpad Enter even when editor-level shortcuts intercept the first keyboard event.
- [x] Keep every folder visibly highlighted during folder-only and mixed multi-selection.
- [x] Select inclusive visible-row ranges with Shift and extend ranges with Ctrl/Cmd+Shift.
- [x] Normalise Explorer item-name typography and align custom flow icons independently.
- [x] Keep newly created flows enabled after inline naming while retaining full state inheritance for moved content.
- [x] Use slightly smaller item-name text and place only custom flow icons one pixel below the native baseline.
- [x] Leave the Explorer viewport unchanged when a newly created folder or flow is already fully visible.
- [x] Reveal and centre clipped or off-screen newly created rows, expanding their collapsed parent path when needed.

## Compatibility boundary to monitor

Node-RED 5 does not expose a public folder insertion API for `RED.sidebar.info.outliner`. This build uses the TreeList item's documented detach/add-child behavior while locating the Explorer's internal TreeList. Re-test this integration when upgrading Node-RED; the plugin intentionally does not fall back to a second, duplicated explorer.
