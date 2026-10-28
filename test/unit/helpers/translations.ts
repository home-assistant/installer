// Stands in for Vite's import.meta.glob of the translations next to en.json,
// as if a German one shipped
Object.assign(globalThis, {
  translations: () => ({
    "./de.json": async () => ({
      "common.app_title": "Home Assistant Installationsprogramm",
      "views.welcome_view.let_s_go": "Los geht's",
    }),
  }),
});
