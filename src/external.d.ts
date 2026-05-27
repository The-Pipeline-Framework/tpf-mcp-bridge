declare module "../template-generator-node/src/browser-template-engine.js" {
  const BrowserTemplateEngine: any;
  export default BrowserTemplateEngine;
}

declare module "../template-generator-node/src/template-bundle.js" {
  const templates: Record<string, string>;
  export default templates;
}
