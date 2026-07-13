declare module "app-generator/src/browser-template-engine.js" {
  const BrowserTemplateEngine: any;
  export default BrowserTemplateEngine;
}

declare module "app-generator/src/template-bundle-precompiled.js" {
  const templates: Record<string, string>;
  export default templates;
}
