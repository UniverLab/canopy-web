// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's stylesheet, injected by the editor chunk itself so the
 * main bundle keeps its budget: the toolbar, the three-pane body
 * (palette, canvas, inspector), the chooser, the import box and the
 * share block. One injected `<style>`; calling `injectEditorStyles`
 * twice mounts it once.
 *
 * Narrow screens stack the panes — palette as a row, canvas, inspector
 * below — so the page never scrolls sideways at 390 px.
 */
const CSS = `
.remote-editor{min-height:100vh;display:flex;flex-direction:column;gap:12px;padding:12px 16px 32px;box-sizing:border-box}
.remote-editor [hidden]{display:none!important}
.remote-editor .editor-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.remote-editor .editor-toolbar .button{display:inline-flex;align-items:center;gap:6px}
.remote-editor .editor-status{margin-left:auto;font-size:13px;opacity:.85}
.remote-editor .editor-status.has-problems{color:#ff6b6b}
.remote-editor .editor-notice{margin:0;padding:8px 12px;border:1px solid #ff6b6b;border-radius:8px;font-size:13px}
.remote-editor .editor-problems{margin:0;padding:8px 12px 8px 28px;border:1px solid #5a6360;border-radius:8px;font-size:13px;max-height:120px;overflow:auto}
.remote-editor .editor-problems code{margin-right:8px;opacity:.75}
.remote-editor .editor-import{border:1px solid #5a6360;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px}
.remote-editor .editor-import textarea{width:100%;box-sizing:border-box;font-family:var(--font-mono,"Sometype Mono",monospace);font-size:12px}
.remote-editor .editor-import-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.remote-editor .editor-file{display:inline-flex;align-items:center;gap:6px;cursor:pointer;text-decoration:underline;font-size:13px}
.remote-editor #editor-import-file{position:absolute;width:1px;height:1px;opacity:0}
.remote-editor .editor-import-error{margin:0;color:#ff6b6b;font-size:13px}
.remote-editor .editor-body{flex:1;display:grid;grid-template-columns:180px minmax(0,1fr) 300px;gap:12px;min-height:0}
.remote-editor .editor-palette{border:1px solid #5a6360;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px;align-content:start}
.remote-editor .editor-palette .kicker{margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.75}
.remote-editor .editor-kind{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #5a6360;border-radius:8px;background:none;color:inherit;cursor:pointer;font-size:13px}
.remote-editor .editor-kind:hover{border-color:var(--canopy,#00a9a0)}
.remote-editor .editor-stage{position:relative;border:1px solid #5a6360;border-radius:8px;overflow:hidden;min-height:420px;background:#04110f}
.remote-editor .editor-svg{display:block;width:100%;height:100%;min-height:420px;touch-action:none}
.remote-editor .editor-empty{position:absolute;left:12px;top:8px;right:12px;margin:0;font-size:13px;opacity:.7;pointer-events:none}
.remote-editor .editor-zoom{position:absolute;right:8px;bottom:8px;display:flex;gap:4px}
.remote-editor .editor-zoom button{min-width:36px;min-height:36px;border:1px solid #5a6360;border-radius:8px;background:#0c1416;color:inherit;cursor:pointer;font-size:14px}
.remote-editor .editor-zoom button:hover{border-color:var(--canopy,#00a9a0)}
.remote-editor .editor-zoom [data-action="clear"]{padding:0 10px;font-size:13px}
.remote-editor .editor-chooser{position:absolute;display:flex;flex-direction:column;gap:8px;background:#0c1416;border:1px solid var(--canopy,#00a9a0);border-radius:8px;padding:10px;z-index:2}
.remote-editor .editor-chooser-title{margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.75}
.remote-editor .editor-chooser-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.remote-editor .editor-chooser-row button{padding:6px 10px;cursor:pointer}
.remote-editor .editor-chooser-route{display:inline-flex;gap:6px;align-items:center}
.remote-editor .editor-chooser-cancel{align-self:flex-start;background:none;border:none;color:inherit;cursor:pointer;text-decoration:underline;font-size:13px}
.remote-editor .editor-panel{border:1px solid #5a6360;border-radius:8px;padding:12px;overflow:auto;max-height:70vh}
.remote-editor .editor-panel .kicker{margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.75}
.remote-editor .editor-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.remote-editor .editor-field label{font-size:13px}
.remote-editor .editor-field input,.remote-editor .editor-field select,.remote-editor .editor-field textarea{font-size:13px;padding:6px 8px;box-sizing:border-box;width:100%}
.remote-editor .editor-field textarea{font-family:var(--font-mono,"Sometype Mono",monospace)}
.remote-editor .editor-field-error{margin:2px 0 0;color:#ff6b6b;font-size:12px}
.remote-editor .editor-hint{font-size:13px;opacity:.8}
.remote-editor .editor-danger{color:#ff6b6b;border-color:#ff6b6b}
.remote-editor .editor-kept{margin-top:16px;border-top:1px solid #5a6360;padding-top:8px}
.remote-editor .editor-kept-note{font-size:12px;opacity:.75}
.remote-editor .editor-kept-list{margin:0;font-size:13px}
.remote-editor .editor-kept-list .field{display:flex;gap:8px;margin:2px 0}
.remote-editor .editor-kept-list dt{opacity:.75}
.remote-editor .editor-kept-list dd{margin:0}
.remote-editor .editor-edge-endpoints{font-size:13px}
.remote-editor .editor-share{border:1px solid var(--canopy,#00a9a0);border-radius:8px;padding:12px}
.remote-editor .editor-share .kicker{margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.75}
.remote-editor .row-install{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.remote-editor .row-install code{font-size:13px;word-break:break-all}
.remote-editor .editor-share-note{margin:8px 0 0;font-size:13px;opacity:.85}
@media (max-width:900px){
.remote-editor .editor-body{grid-template-columns:1fr}
.remote-editor .editor-palette{flex-direction:row;flex-wrap:wrap;align-items:center}
.remote-editor .editor-palette .kicker{flex-basis:100%}
.remote-editor .editor-kind{flex:1 1 auto;justify-content:center}
.remote-editor .editor-panel{max-height:none}
}
`;

/** Mount the editor stylesheet once; later calls are no-ops. */
export function injectEditorStyles(): void {
  if (document.getElementById("remote-editor-styles") !== null) {
    return;
  }
  const style = document.createElement("style");
  style.id = "remote-editor-styles";
  style.textContent = CSS;
  document.head.append(style);
}
