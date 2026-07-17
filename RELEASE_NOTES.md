# Artwork Positioner 1.0

The first public release of Artwork Positioner combines Logo Positioner and Hero Position into one Millennium plugin, one settings page, and one shared Steam window integration.

## Highlights

- Move and resize game logos in Steam Desktop and Big Picture Mode.
- Adjust horizontal and vertical hero crop positions in both modes.
- Keep independent per-game Desktop and Big Picture values for logos and heroes.
- Open **Adjust Hero Position...** and **Move/Resize Logo** from Steam context menus.
- Preserve saved logo geometry when Steam rerenders a page or SteamGridDB replaces the logo.
- Work alongside Steam's native Desktop logo-position editor.
- Automatically migrate Logo Positioner browser data and Hero Position offsets.
- Persist logo data to disk and generate narrowly scoped per-game hero CSS.

## Reliability and safety

The logo runtime uses one exclusive editing state, event-driven mutation/resize observation, and no logo timers or polling. Plugin resize controls are isolated from Steam's native editor, complete width/height values survive later moves, and stale browser storage cannot overwrite newer disk data.

Artwork Positioner keeps its databases and generated CSS inside the plugin folder. It does not edit Steam-managed `steamui` files or write generated rules into a theme.

## Installation

1. Download `ArtworkPositioner-Millennium-v1.0.0.zip` below.
2. Extract the `Artwork Positioner` folder into `Steam/millennium/plugins`.
3. Enable **Artwork Positioner** in Millennium.
4. Restart Steam.

If migrating from the separate plugins, run Artwork Positioner once while their folders/data are still available. Verify several games, then disable or remove **Logo Positioner** and **Hero Position**.
