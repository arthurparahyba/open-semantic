import { useEffect, useRef, useState } from "react";

import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";

import type { ArtifactReference, ModInstance } from "@open-semantic/protocol";

import { run } from "../client.js";

interface Props {
  mod: ModInstance;
  artifact: ArtifactReference | undefined;
  onDirtyChange(dirty: boolean): void;
  onError(message: string): void;
}

type Status = { kind: "loading" } | { kind: "ready" } | { kind: "conflict" } | { kind: "error"; message: string };

function languageFor(path: string): Extension[] {
  if (/\.(m|c)?(j|t)sx?$/.test(path)) return [javascript({ jsx: true, typescript: /\.tsx?$/.test(path) })];
  if (/\.json$/.test(path)) return [json()];
  if (/\.(md|markdown)$/.test(path)) return [markdown()];
  return [];
}

/**
 * Editor de texto sobre um arquivo real. Salva com a impressão (hash) lida na abertura:
 * se o arquivo mudou fora do app, mostra o conflito em vez de sobrescrever (critério B4).
 */
export function Editor({ mod, artifact, onDirtyChange, onError }: Props) {
  const fileRef = mod.config.fileRef as string;
  const path = artifact && "path" in artifact.locator ? artifact.locator.path : "";
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const baseHash = useRef<string | undefined>(undefined);
  const savedText = useRef("");
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [dirty, setDirty] = useState(false);

  const markDirty = (value: boolean) => {
    setDirty(value);
    onDirtyChange(value);
  };

  const load = async () => {
    setStatus({ kind: "loading" });
    const result = await run("project.read_file", { artifactId: fileRef });
    if (result.status !== "succeeded") {
      setStatus({ kind: "error", message: result.error?.message ?? "Não foi possível abrir o arquivo." });
      return;
    }
    const { content, fingerprint } = result.output as { content: string; fingerprint: { contentHash?: string } };
    baseHash.current = fingerprint.contentHash;
    savedText.current = content;
    view.current?.dispatch({ changes: { from: 0, to: view.current.state.doc.length, insert: content } });
    markDirty(false);
    setStatus({ kind: "ready" });
  };

  const save = async (force = false) => {
    if (!view.current) return;
    const content = view.current.state.doc.toString();
    const result = await run("project.write_file", {
      artifactId: fileRef,
      content,
      ...(force || !baseHash.current ? {} : { expectedContentHash: baseHash.current }),
    });
    if (result.status === "succeeded") {
      baseHash.current = (result.output as { fingerprint: { contentHash?: string } }).fingerprint.contentHash;
      savedText.current = content;
      markDirty(false);
      setStatus({ kind: "ready" });
    } else if (result.error?.code === "EXTERNAL_CHANGE_CONFLICT") {
      setStatus({ kind: "conflict" });
    } else onError(result.error?.message ?? "Não foi possível salvar.");
  };

  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: "",
        extensions: [
          keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (void saveRef.current(), true) }]),
          basicSetup,
          ...languageFor(path),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) markDirty(update.state.doc.toString() !== savedText.current);
          }),
        ],
      }),
    });
    void load();
    return () => view.current?.destroy();
    // O editor é recriado só quando o arquivo muda.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileRef]);

  return (
    <div className="editor">
      <div className="editor-toolbar">
        <span className="editor-path" title={path}>
          {path}
        </span>
        <span className={`editor-state${dirty ? " is-dirty" : ""}`} data-testid="editor-state">
          {status.kind === "loading" ? "abrindo…" : dirty ? "● não salvo" : "salvo"}
        </span>
        <button type="button" onClick={() => void save()} disabled={!dirty} title="Salvar (Ctrl/⌘+S)">
          Salvar
        </button>
      </div>
      {status.kind === "conflict" && (
        <div className="editor-banner" role="alert">
          O arquivo mudou fora do editor desde que foi aberto.
          <button type="button" onClick={() => void load()}>
            Recarregar do disco
          </button>
          <button type="button" onClick={() => void save(true)}>
            Sobrescrever
          </button>
        </div>
      )}
      {status.kind === "error" && (
        <div className="editor-banner is-error" role="alert">
          {status.message}
        </div>
      )}
      <div ref={host} className="editor-host" />
    </div>
  );
}
