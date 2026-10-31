
  # Personal AI Assistant Dashboard

  This is a code bundle for Personal AI Assistant Dashboard. The original project is available at https://www.figma.com/design/z2ZfDUzV1ztmJzWdeUpibM/Personal-AI-Assistant-Dashboard.

  ## Running the code

  Run `npm i` to install the dependencies.

  Run `npm run dev` to start the development server.

  ## Variants

  Default dashboard:

  ```text
  http://localhost:5231
  ```

  Sweet room dashboard:

  ```text
  http://localhost:5231/?variant=sweet-room
  ```

  You can also set `VITE_CONTROL_CENTER_VARIANT=sweet-room` in `.env` when you want sweet room to be the default.

  Overview dashboard:

  ```text
  http://localhost:5231/?variant=overview
  ```

  Select **Settings → Appearance** to save the layout in this browser. Overview
  includes the Family map, light controls, computer status and an optional
  Live2D stage with an audio waveform. See [Overview setup and verification](../docs/CONTROL_CENTER_OVERVIEW.md)
  for area-name configuration and runtime limits.
