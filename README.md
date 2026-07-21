# Artwork Positioner

Artwork Positioner is a [Millennium](https://steambrew.app/) plugin for controlling Steam library-page logos and hero artwork from one settings page and one shared Steam window integration.

It combines the Logo Positioner and Hero Position logic while keeping their editing systems independent: logos can be dragged and resized, while heroes use horizontal and vertical crop offsets.

## Features

### Logo positioning

- Drag and resize game logos in Desktop and Big Picture Mode.
- Store independent Desktop and Big Picture positions and sizes for every game.
- Reapply saved geometry when Steam rerenders a game page.
- Preserve saved geometry when a logo is replaced through SteamGridDB.
- Work alongside Steam's native **Adjust Logo Position** editor.
- Reset a plugin-owned logo position without modifying Steam artwork files.
- Import and export the logo-position database.

### Hero positioning

- Adjust horizontal and vertical hero crop offsets per game.
- Apply Big Picture offsets only to the active game-details hero, leaving library/home backdrops centered.
- Store four independent values per game: Desktop horizontal/vertical and Big Picture horizontal/vertical.
- Open the editor from the game context menu or plugin settings.
- Generate narrowly scoped CSS for only the games with saved offsets.
- Keep all generated CSS inside the plugin directory.

### Shared integration

- One Millennium plugin and settings page.
- One shared Steam window observer for both artwork modules.
- **Adjust Hero Position...** and **Move/Resize Logo** context-menu actions.
- Automatic migration from the two original plugins.
- Persistent disk-backed storage with browser-storage migration support.

## Installation

1. Install [Millennium](https://steambrew.app/).
2. Download `ArtworkPositioner-Millennium-v1.0.0.zip` from the [latest release](https://github.com/DevsNate/ArtworkPositioner-Millennium/releases/latest).
3. Extract the `Artwork Positioner` folder into:

   ```text
   Steam/millennium/plugins/
   ```

4. Enable **Artwork Positioner** in Millennium.
5. Restart Steam.

## Usage

### Move or resize a logo

1. Open a game in the Steam library.
2. Right-click the game or its artwork and select **Move/Resize Logo**.
3. Drag the logo to move it or drag an edge/corner handle to resize it.
4. Select **Done** to save the complete position and size.

The same saved geometry is reapplied when Steam rebuilds the page or SteamGridDB replaces the logo element. Desktop and Big Picture Mode use separate records.

### Adjust a hero

1. Open a game in the Steam library.
2. Select **Adjust Hero Position...** from the game context menu, or open Artwork Positioner in Millennium settings.
3. Adjust the horizontal and vertical offsets for Desktop or Big Picture Mode.
4. Center either axis with its corresponding reset button.

Hero offsets range from -600 px to 600 px and are stored per game and per Steam mode.

## Migration from the original plugins

Artwork Positioner recognizes and migrates:

- Logo Positioner's configuration and position database from browser storage.
- Hero Positioner's `offsets.json` data.
- Existing Desktop and Big Picture values for both artwork types.

For the safest migration, install and run Artwork Positioner once while the old plugin folders are still available. After verifying several saved games, disable or remove **Logo Positioner** and **Hero Position** so only Artwork Positioner owns the shared window and context-menu integration.

## Data and Steam safety

Runtime data is kept inside the Artwork Positioner plugin folder:

- `logo-data.json` stores logo positions, sizes, and logo settings.
- `offsets.json` stores hero offsets.
- `generated/hero-position.css` contains the generated per-game hero rules.

Artwork Positioner does not edit Steam-managed `steamui` files or inject generated rules into a theme. Runtime databases are excluded from the repository and release package, so installing an update does not include another user's saved positions.

## Development

Requirements: Node.js 22 or newer and pnpm 10.

```powershell
pnpm install --frozen-lockfile
pnpm build
```

The production frontend is written to `.millennium/Dist/index.js`. A minimal install package contains:

```text
Artwork Positioner/
├── .millennium/Dist/index.js
├── backend/main.lua
└── plugin.json
```

## Credits

- Logo positioning is based on and substantially extends [luthor112/steam-logo-pos](https://github.com/luthor112/steam-logo-pos).
- Hero Position and the combined Artwork Positioner integration were developed by [DevsNate](https://github.com/DevsNate).
- Built for [Millennium](https://github.com/SteamClientHomebrew/Millennium).

## License

Artwork Positioner is released under the [MIT License](LICENSE).
