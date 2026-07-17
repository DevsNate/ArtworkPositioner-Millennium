# Changelog

## 1.0.0 - 2026-07-17

Initial public release of Artwork Positioner.

### Added

- A combined Millennium plugin for logo and hero positioning.
- Logo dragging, edge/corner resizing, reset, import, and export.
- Horizontal and vertical hero crop controls.
- Independent Desktop and Big Picture values for both artwork types.
- Context-menu actions for both editors, with the logo action placed after the hero action.
- Automatic migration from Logo Positioner browser data and Hero Position offsets.
- Disk-backed logo persistence and narrowly scoped generated hero CSS.

### Reliability

- Uses one exclusive logo runtime state for idle, plugin editing, and Steam native editing.
- Reapplies saved logo geometry after Steam page rerenders and SteamGridDB logo replacements.
- Preserves logo width and height while moving a previously resized logo.
- Keeps plugin resize controls separate from Steam's native logo editor.
- Uses event-driven mutation and resize observation without logo timers or polling.
- Cleans up window controllers and observers when the plugin unloads or reloads.

### Safety

- Does not modify Steam-managed `steamui` files.
- Keeps generated hero CSS and all saved data inside the plugin directory.
- Excludes runtime databases from source control and release packages.
