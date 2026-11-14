export function applyRootUiFont(uiFontStack: string): void {
  const value = uiFontStack.replace(/[<>{}();\r\n]/g, " ").trim();
  if (!value) return;
  document.documentElement.style.setProperty("--paseo-ui-font", value);
  if (document.getElementById("gram-paseo-ui-font")) return;
  const style = document.createElement("style");
  style.id = "gram-paseo-ui-font";
  style.textContent =
    "[data-paseo-chat] *:not([data-pmono]):not([data-pmono] *){font-family:var(--paseo-ui-font);}";
  document.head.appendChild(style);
}
