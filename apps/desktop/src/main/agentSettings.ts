// Configurações do agente de IA e a chave da API. Ficam só no processo principal:
// a chave é cifrada com o cofre do sistema (safeStorage) e nunca vai para a interface.
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { safeStorage } from "electron";

import { AnthropicProvider, ScriptedProvider, type LlmProvider } from "@open-semantic/llm";

import type { AgentSettingsView } from "../shared/api.js";

interface StoredSettings {
  model: string;
  maxCostPerRequestUsd: number;
}

const DEFAULTS: StoredSettings = { model: "claude-haiku-5-5", maxCostPerRequestUsd: 0.1 };
const MAX_COST_CEILING = 5;

export class AgentSettings {
  private settings: StoredSettings = { ...DEFAULTS };
  /** Chave em claro só na memória do processo principal. */
  private key: string | undefined;
  private keySource: AgentSettingsView["key"]["source"] = "none";
  private provider: LlmProvider | undefined;

  private constructor(
    private readonly dataDir: string,
    private readonly scriptedFile: string | undefined,
  ) {}

  static async load(dataDir: string, scriptedFile?: string) {
    const s = new AgentSettings(dataDir, scriptedFile);
    try {
      const stored = JSON.parse(await readFile(s.settingsFile, "utf8")) as Partial<StoredSettings>;
      s.settings = sanitize({ ...DEFAULTS, ...stored });
    } catch {
      // primeira vez: fica o padrão
    }
    try {
      if (safeStorage.isEncryptionAvailable()) {
        s.key = safeStorage.decryptString(await readFile(s.keyFile));
        s.keySource = "saved";
      }
    } catch {
      // sem chave salva
    }
    if (!s.key && process.env.ANTHROPIC_API_KEY) {
      s.key = process.env.ANTHROPIC_API_KEY;
      s.keySource = "env";
    }
    s.rebuild();
    return s;
  }

  private get settingsFile() {
    return join(this.dataDir, "agent-settings.json");
  }
  private get keyFile() {
    return join(this.dataDir, "anthropic-key.bin");
  }

  current(): StoredSettings {
    return { ...this.settings };
  }

  activeProvider(): LlmProvider | undefined {
    return this.provider;
  }

  view(): AgentSettingsView {
    const provider = this.provider ?? new AnthropicProvider({ apiKey: "" });
    return {
      provider: provider.id,
      providerLabel: provider.label,
      models: provider.models.map((m) => ({ id: m.id, label: m.label, note: m.note, inputPerMTok: m.pricing.input, outputPerMTok: m.pricing.output })),
      model: this.settings.model,
      maxCostPerRequestUsd: this.settings.maxCostPerRequestUsd,
      key: {
        configured: this.provider !== undefined,
        source: this.scriptedFile ? "test" : this.keySource,
        ...(this.key ? { hint: `…${this.key.slice(-4)}` } : {}),
      },
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    };
  }

  async update(patch: Partial<StoredSettings>) {
    this.settings = sanitize({ ...this.settings, ...patch });
    await writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2), "utf8");
    return this.view();
  }

  /** Salva (ou apaga, com null) a chave. Sem cofre do sistema, ela fica só até fechar o app. */
  async setKey(key: string | null): Promise<{ ok: true; view: AgentSettingsView } | { ok: false; message: string }> {
    if (key === null) {
      this.key = undefined;
      this.keySource = "none";
      await rm(this.keyFile, { force: true });
      this.rebuild();
      return { ok: true, view: this.view() };
    }
    const trimmed = key.trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
      return { ok: false, message: "Isso não parece uma chave da API da Anthropic (começa com sk-ant-)." };
    }
    this.key = trimmed;
    if (safeStorage.isEncryptionAvailable()) {
      await writeFile(this.keyFile, safeStorage.encryptString(trimmed));
      this.keySource = "saved";
    } else {
      this.keySource = "memory";
    }
    this.rebuild();
    return { ok: true, view: this.view() };
  }

  private rebuild() {
    if (this.scriptedFile) this.provider = new ScriptedProvider(this.scriptedFile);
    else this.provider = this.key ? new AnthropicProvider({ apiKey: this.key }) : undefined;
  }
}

function sanitize(s: StoredSettings): StoredSettings {
  const known = new AnthropicProvider({ apiKey: "" }).models.map((m) => m.id);
  const cost = Number(s.maxCostPerRequestUsd);
  return {
    model: known.includes(s.model) ? s.model : DEFAULTS.model,
    maxCostPerRequestUsd: Number.isFinite(cost) && cost > 0 ? Math.min(cost, MAX_COST_CEILING) : DEFAULTS.maxCostPerRequestUsd,
  };
}
