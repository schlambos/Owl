/**
 * Isolated Vite worker entry. Tests never import this module.
 */
import EditorWorker from "../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";
import JsonWorker from "../../node_modules/monaco-editor/esm/vs/language/json/json.worker.js?worker";

export { EditorWorker, JsonWorker };
