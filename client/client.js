window.__ModuleLoader__.load({ id: "dsh-skill-mcp-hub", factory: (require) => {

  // 能力库（unified hub）—— 单一设置页，四个页签：技能 / MCP / 全局 Prompt / 文件。
  // 技能 / Prompt / 文件走本包 host 的 /api/hub（文件系统级，跨内核版本稳定）；
  // MCP 页签复用 dsh-skill-mcp-manager 引擎的 /skill-mcp-manager/* 同源路由
  // （档位、按需加载、按会话实例、快照、单工具黑名单都在引擎里）。

  const React = require("react");
  const h = React.createElement;
  const { useState, useEffect, useCallback } = React;

  const name = "dsh-hub";
  const inject = ["slots"];

  // ── fetch ────────────────────────────────────────────────────────────────
  async function getJson(path) {
    const res = await fetch(path, { cache: "no-store" });
    const data = await res.json().catch(() => ({ ok: false, error: "HTTP " + res.status }));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  async function postJson(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "HTTP " + res.status }));
    if (!res.ok || data.ok === false) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  // 本包 host 的 JSON-RPC：POST /api/hub { method, args } → { ok, value | error }
  async function hub(method, args) {
    const res = await fetch("/api/hub", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ method, args: args ?? {} }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: { message: "HTTP " + res.status } }));
    if (!data.ok) {
      throw new Error(data.error && data.error.message ? data.error.message : "HTTP " + res.status);
    }
    return data.value;
  }

  function cx() {
    return Array.prototype.filter.call(arguments, Boolean).join(" ");
  }

  function errText(error) {
    return String(error && error.message ? error.message : error);
  }

  // ── primitives ───────────────────────────────────────────────────────────
  function Switch(props) {
    const checked = props.checked === true;
    const disabled = props.disabled === true;
    return h("button", {
      type: "button",
      role: "switch",
      "aria-checked": checked ? "true" : "false",
      className: cx("smx-switch", checked && "is-on"),
      disabled,
      onClick: () => props.onChange(!checked),
    }, h("span", { className: "smx-switch__knob" }));
  }

  function Badge(props) {
    return h("span", { className: cx("smx-badge", props.tone ? "smx-badge--" + props.tone : "") }, props.children);
  }

  function Notice(props) {
    return h("div", { className: cx("smx-notice", props.kind ? "smx-notice--" + props.kind : "") },
      h("span", null, props.children),
      props.onDismiss
        ? h("button", { type: "button", className: "smx-notice__close", onClick: props.onDismiss }, "\u00d7")
        : null,
    );
  }

  function Empty(props) {
    return h("div", { className: "smx-empty" }, props.children);
  }

  // ── legacy session notice ────────────────────────────────────────────────
  // Sessions written before 1.1.5 cannot be opened once DSH reaches 2.0.9. The
  // host scans for them on every start while its `check` flag is set, reports the
  // count, and retires the flag by itself once a scan finds nothing. This only
  // points at the repair guide — nothing here repairs anything, and there is no
  // dismiss: an accidental click must not be able to hide a real problem.
  const REPAIR_GUIDE_URL = "https://github.com/alone-tree/dsh-skill-mcp-manager/issues/2";
  const AUDIT_POLL_MS = 5000;
  const AUDIT_POLL_LIMIT = 36;

  // The host reports a running scan explicitly, and the answer may take tens of
  // seconds on a large library, so poll while either is unsettled. A settled
  // check never polls at all.
  function useLegacyAudit() {
    const [audit, setAudit] = useState(null);
    useEffect(() => {
      let cancelled = false;
      let timer = null;
      let attempts = 0;
      const load = async () => {
        try {
          const data = await getJson("/skill-mcp-manager/session-audit");
          if (cancelled) return;
          setAudit(data);
          const unsettled = data.scanning === true || data.affected > 0;
          if (unsettled && attempts < AUDIT_POLL_LIMIT) {
            attempts += 1;
            timer = setTimeout(load, AUDIT_POLL_MS);
          }
        } catch {
          /* advisory only — a failed fetch stays silent */
        }
      };
      load();
      return () => {
        cancelled = true;
        if (timer !== null) clearTimeout(timer);
      };
    }, []);
    return audit;
  }

  function legacySessionsOpen(audit) {
    return audit !== null && audit.scanning !== true && audit.check !== false && audit.affected > 0;
  }

  function auditScanning(audit) {
    return audit !== null && audit.scanning === true;
  }

  // The result is told once per browser session, and the fact that it was told
  // is remembered in sessionStorage rather than on the host — a plugin whose one
  // job here is telling the user something should not grow a state file and a
  // write route to remember that the telling happened.
  //
  // The wait notice and the result toast need separate keys, because they are
  // separate conditions rather than one shared "already told" flag: they used to
  // share one, and closing the wait notice then counted as having told the
  // result, so the result was never shown at all (found on-machine 2026-09-14).
  const CHECK_TOAST_KEY = "dsh-skill-mcp-manager:checking-seen";
  const RESULT_TOAST_KEY = "dsh-skill-mcp-manager:result-shown";

  function sessionRemember(key) {
    try {
      window.sessionStorage.setItem(key, "1");
    } catch {
      /* a browser that refuses storage just shows the notice again */
    }
  }

  function sessionSeen(key) {
    try {
      return window.sessionStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  }

  // The settled answer of a scan that ran in this process, told once for this
  // browser session. `checked` is what makes the difference between news and an
  // old conclusion: a retired check reads its record off disk on every start, and
  // announcing that as a result is what made "没有会话受影响" re-appear on every
  // restart (2026-09-14, on-machine). The banner does not use this at all: while
  // the check is open and something is affected it stays on screen.
  function auditResultShown(audit) {
    if (audit === null || audit.done !== true || audit.checked !== true || auditScanning(audit)) return false;
    return !sessionSeen(RESULT_TOAST_KEY);
  }

  // The banner is dismissed for the session, and — the mistake above — that must
  // not read as the result having been told.
  function bannerAvailable(audit) {
    return legacySessionsOpen(audit);
  }

  // Settings-page banner: the full explanation and the report to hand to an AI.
  // Whether it appears is decided by the host state alone — the check is open and
  // something is affected — so it comes back with the page and leaves only when
  // the problem is dealt with. Its close hides it just for this mount.
  function LegacySessionBanner() {
    const audit = useLegacyAudit();
    const [closed, setClosed] = useState(false);
    if (closed || !bannerAvailable(audit)) return null;
    return h(Notice, { kind: "error", onDismiss: () => {
      setClosed(true);
    } },
      h("span", { className: "smx-legacy" },
        h("span", { className: "smx-legacy__title" }, `因 DSH 版本升级，有 ${audit.affected} 个历史会话无法查看`),
        h("span", null,
          "DSH 升级后调整了 MCP 注入消息的格式规范，旧会话的 MCP 注入消息不再被支持，打开时会显示",
          h("code", { className: "smx-legacy__code" }, "历史加载失败：failed to observe session … cannot safely transform unclassified message source"),
          "。把上面这段报错交给 AI，让它去修；插件的提示里不含修复操作，详情见",
          h("a", { className: "smx-legacy__link", href: REPAIR_GUIDE_URL, target: "_blank", rel: "noreferrer" }, "本项目 issue"),
        ),
        h("span", { className: "smx-legacy__note" },
          "修好后不需要手动关闭：下次启动扫描到 0 会自动停止。若你决定不修复这些会话，把 ",
          h("code", { className: "smx-legacy__code" }, "~/.dsh/skill-mcp-manager/session-audit.json"),
          " 里的 ",
          h("code", { className: "smx-legacy__code" }, `"check": false`),
          " 写入即可停止提示。",
        ),
      ),
    );
  }

  // One toast per state. While the check runs it says so and asks for patience;
  // when the answer lands it replaces that with the result — a problem to hand
  // to an AI, or an all-clear. Closing the wait notice does not stop the check,
  // so the result still gets its turn.
  //
  // Closing goes through sessionStorage for both, so a closed notice stays
  // closed after a reload — and, because the two keys differ, closing the wait
  // notice can no longer swallow the result.
  function LegacySessionOverlay() {
    const audit = useLegacyAudit();
    // Closing writes to sessionStorage, not to React state, so it has to force a
    // render to take effect.
    const [, setTick] = useState(0);
    const checking = auditScanning(audit);
    const shown = auditResultShown(audit);
    if (checking && !sessionSeen(CHECK_TOAST_KEY)) {
      return h("div", { className: "smx-toast smx-toast--checking", role: "status" },
        h("div", { className: "smx-toast__main" },
          h("div", { className: "smx-toast__title" }, "因 DSH 版本升级，历史会话可能无法打开，能力库正在检查"),
          h("div", { className: "smx-toast__text" }, "若历史会话较多，可能需要一些时间，请耐心等待；检查期间历史会话目录可能暂时无法查看。本检查是一次性临时动作，修复后不会再次出现。"),
        ),
        h("button", {
          type: "button",
          className: "smx-toast__close",
          title: "本次不再显示",
          onClick: () => {
            sessionRemember(CHECK_TOAST_KEY);
            setTick((value) => value + 1);
          },
        }, "\u00d7"),
      );
    }
    if (shown) {
      const affected = audit.affected;
      return h("div", { className: "smx-toast" + (affected > 0 ? " smx-toast--alert" : " smx-toast--ok"), role: "status" },
        h("div", { className: "smx-toast__main" },
          h("div", { className: "smx-toast__title" }, affected > 0
            ? `因 DSH 版本升级，有 ${affected} 个历史会话无法查看`
            : "没有会话受影响，请放心使用"),
          h("div", { className: "smx-toast__text" }, affected > 0
            ? "把报错交给 AI，让它去修；详情见「设置 → 能力库」。"
            : "历史会话检查已完成，以后不会再检查。"),
        ),
        h("button", {
          type: "button",
          className: "smx-toast__close",
          title: affected > 0 ? "本次不再显示" : "知道了",
          onClick: () => {
            sessionRemember(RESULT_TOAST_KEY);
            setTick((value) => value + 1);
          },
        }, "\u00d7"),
      );
    }
    return null;
  }

  function kv(key, value) {
    return h("div", { className: "smx-kv", key },
      h("span", { className: "smx-kv__k" }, key),
      h("span", { className: "smx-kv__v" }, value === null || value === undefined || value === "" ? "\u2014" : String(value)),
    );
  }

  // ── Skills panel ─────────────────────────────────────────────────────────
  // 下面这个 SkillsPanel 是引擎自带的版本（走 ctx.skills，需要 preset scope）；
  // 在拿不到 scope 的内核上它会显示 0 个技能，所以页签实际用的是 HubSkillsPanel。
  function SkillsPanel() {
    const [skills, setSkills] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [confirming, setConfirming] = useState("");

    const refresh = useCallback(async () => {
      setLoading(true);
      setError("");
      try {
        const data = await getJson("/skill-mcp-manager/skills");
        setSkills(data.skills || []);
      } catch (err) {
        setError(errText(err));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    async function toggle(skill) {
      try {
        await postJson("/skill-mcp-manager/skills/toggle", { name: skill.name, enabled: !skill.modelInvocable });
        setSkills((current) => current && current.map((item) =>
          item.name === skill.name ? { ...item, modelInvocable: !skill.modelInvocable } : item,
        ));
      } catch (err) {
        setError(errText(err));
      }
    }

    async function open(skill) {
      try {
        await postJson("/skill-mcp-manager/skills/open", { name: skill.name });
        setNotice("已用系统编辑器打开 " + skill.path);
      } catch (err) {
        setError(errText(err) + " \u2014 " + skill.path);
      }
    }

    async function remove(skill) {
      setConfirming("");
      try {
        await postJson("/skill-mcp-manager/skills/delete", { name: skill.name });
        setNotice("已删除 " + skill.name);
        await refresh();
      } catch (err) {
        setError(errText(err));
      }
    }

    const rows = (skills || []).map((skill) => h("li", { key: skill.name, className: "smx-row" },
      h("div", { className: "smx-row__main" },
        h("div", { className: "smx-row__top" },
          h("span", { className: "smx-row__name" }, skill.name),
          skill.readonly ? h(Badge, { tone: "muted" }, "只读") : null,
          h("span", { className: "smx-row__path" }, skill.path),
        ),
        skill.description ? h("div", { className: "smx-row__desc" }, skill.description) : null,
      ),
      h("div", { className: "smx-row__actions" },
        skill.readonly
          ? h("span", { className: "smx-switchline__label" }, "只读（不可启停）")
          : h("label", { className: "smx-switchline" },
              h(Switch, { checked: skill.modelInvocable, onChange: () => toggle(skill) }),
              h("span", { className: "smx-switchline__label" }, skill.modelInvocable ? "模型可见" : "模型隐藏"),
            ),
        h("button", { type: "button", className: "smx-btn", onClick: () => open(skill) }, "打开"),
        skill.readonly
          ? null
          : confirming === skill.name
            ? h("span", { className: "smx-confirm" },
                h("button", { type: "button", className: "smx-btn smx-btn--danger", onClick: () => remove(skill) }, "确认删除整个文件夹"),
                h("button", { type: "button", className: "smx-btn", onClick: () => setConfirming("") }, "取消"),
              )
            : h("button", { type: "button", className: "smx-btn smx-btn--ghost", onClick: () => setConfirming(skill.name) }, "删除"),
      ),
    ));

    return h("div", { className: "smx" },
      h("div", { className: "smx-head" },
        h("span", { className: "smx-count" }, skills
          ? String(skills.length) + " 个技能 · 模型可见 " + skills.filter((s) => s.modelInvocable).length + " 个"
          : ""),
        h("button", { type: "button", className: "smx-btn", onClick: refresh }, "刷新"),
      ),
      notice ? h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice) : null,
      error ? h(Notice, { kind: "error", onDismiss: () => setError("") }, error) : null,
      loading ? h(Empty, null, "加载中\u2026")
        : skills && skills.length === 0 ? h(Empty, null, "没有可管理的技能（bundle 型 SKILL.md）")
        : h("ul", { className: "smx-list" }, rows),
    );
  }

  // ── Hub 技能面板（文件系统级） ────────────────────────────────────────────
  function HubSkillsPanel() {
    const [state, setState] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [confirming, setConfirming] = useState("");
    const [editing, setEditing] = useState("");
    const [draft, setDraft] = useState("");
    const [original, setOriginal] = useState("");
    const [saving, setSaving] = useState(false);
    const [creating, setCreating] = useState(false);
    const [query, setQuery] = useState("");
    const [newName, setNewName] = useState("");
    const [newDesc, setNewDesc] = useState("");

    const refresh = useCallback(async () => {
      setLoading(true);
      setError("");
      try {
        setState(await hub("listSkills"));
      } catch (err) {
        setError(errText(err));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    async function toggle(skill) {
      try {
        await hub("setSkillDisabled", { name: skill.name, disabled: skill.modelInvocable });
        setState((current) => current && {
          ...current,
          skills: current.skills.map((item) => (item.name === skill.name
            ? { ...item, modelInvocable: !skill.modelInvocable }
            : item)),
        });
      } catch (err) {
        setError(errText(err));
      }
    }

    async function edit(skill) {
      try {
        const doc = await hub("readSkill", { name: skill.name });
        setEditing(skill.name);
        setDraft(doc.content);
        setOriginal(doc.content);
        setError("");
      } catch (err) {
        setError(errText(err));
      }
    }

    async function save() {
      setSaving(true);
      try {
        await hub("writeSkill", { name: editing, content: draft });
        setOriginal(draft);
        setNotice("已保存 " + editing);
        setEditing("");
        await refresh();
      } catch (err) {
        setError(errText(err));
      } finally {
        setSaving(false);
      }
    }

    async function create() {
      try {
        const created = await hub("createSkill", { name: newName, description: newDesc });
        setCreating(false);
        setNewName("");
        setNewDesc("");
        setNotice("已创建 " + created.name);
        await refresh();
        await edit({ name: created.name });
      } catch (err) {
        setError(errText(err));
      }
    }

    async function remove(skill) {
      setConfirming("");
      try {
        await hub("removeSkill", { name: skill.name });
        setNotice("已移到 .trash：" + skill.name);
        if (editing === skill.name) setEditing("");
        await refresh();
      } catch (err) {
        setError(errText(err));
      }
    }

    const skills = state ? state.skills : [];
    const needle = query.trim().toLowerCase();
    const visible = needle === ""
      ? skills
      : skills.filter((skill) => [skill.name, skill.description, skill.path, skill.provider, skill.source]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(needle));
    const rows = visible.map((skill) => {
      const isEditing = editing === skill.name;
      return h("li", { key: skill.name, className: "smx-row smx-row--col" },
        h("div", { className: "smx-row__head" },
          h("div", { className: "smx-row__main" },
            h("div", { className: "smx-row__top" },
              h("span", { className: "smx-row__name" }, skill.name),
              skill.readonly ? h(Badge, { tone: "muted" }, "只读") : null,
              !skill.readonly && !skill.modelInvocable ? h(Badge, { tone: "muted" }, "模型隐藏") : null,
              h("span", { className: "smx-row__path" }, skill.path),
            ),
            skill.description ? h("div", { className: "smx-row__desc" }, skill.description) : null,
          ),
          h("div", { className: "smx-row__actions" },
            skill.readonly
              ? h("span", { className: "smx-switchline__label" },
                  "只读" + (skill.provider ? " · " + skill.provider : ""))
              : h("label", { className: "smx-switchline" },
                  h(Switch, { checked: skill.modelInvocable, onChange: () => toggle(skill) }),
                  h("span", { className: "smx-switchline__label" }, skill.modelInvocable ? "模型可见" : "模型隐藏"),
                ),
            skill.readonly ? null : h("button", {
              type: "button",
              className: "smx-btn",
              onClick: () => (isEditing ? setEditing("") : edit(skill)),
            }, isEditing ? "收起" : "编辑"),
            skill.readonly ? null : confirming === skill.name
              ? h("span", { className: "smx-confirm" },
                  h("button", { type: "button", className: "smx-btn smx-btn--danger", onClick: () => remove(skill) }, "确认删除"),
                  h("button", { type: "button", className: "smx-btn", onClick: () => setConfirming("") }, "取消"),
                )
              : h("button", { type: "button", className: "smx-btn smx-btn--ghost", onClick: () => setConfirming(skill.name) }, "删除"),
          ),
        ),
        isEditing ? h("div", { className: "smx-edit" },
          h("textarea", {
            className: "smx-editor",
            value: draft,
            spellCheck: false,
            onChange: (event) => setDraft(event.target.value),
          }),
          h("div", { className: "smx-edit__bar" },
            h("span", { className: "smx-count" }, draft === original ? "未修改" : "有未保存的修改"),
            h("button", { type: "button", className: "smx-btn", onClick: () => { setDraft(original); setEditing(""); } }, "取消"),
            h("button", {
              type: "button",
              className: "smx-btn smx-btn--primary",
              disabled: saving || draft === original,
              onClick: save,
            }, saving ? "保存中…" : "保存"),
          ),
        ) : null,
      );
    });

    return h("div", { className: "smx" },
      h("div", { className: "smx-head" },
        h("span", { className: "smx-count" }, !state
          ? ""
          : needle !== ""
            ? "命中 " + String(visible.length) + " / 共 " + String(skills.length) + " 个技能"
            : String(skills.length) + " 个技能 · 模型可见 " + skills.filter((s) => s.modelInvocable).length + " 个 · " + state.root),
        h("span", { className: "smx-head__meta" },
          h("button", { type: "button", className: "smx-btn", onClick: () => setCreating((v) => !v) }, "＋ 新建"),
          h("button", { type: "button", className: "smx-btn", onClick: refresh }, "刷新"),
        ),
      ),
      h("div", { className: "smx-setting__row" },
        h("input", {
          type: "search",
          className: "smx-input smx-input--wide",
          value: query,
          placeholder: "搜索技能：名字 / 描述 / 路径",
          "aria-label": "搜索技能",
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => { if (event.key === "Escape") setQuery(""); },
        }),
        needle !== "" ? h("button", { type: "button", className: "smx-btn", onClick: () => setQuery("") }, "清除") : null,
      ),
      notice ? h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice) : null,
      error ? h(Notice, { kind: "error", onDismiss: () => setError("") }, error) : null,
      creating ? h("div", { className: "smx-setting smx-setting--block" },
        h("div", { className: "smx-setting__row" },
          h("label", { className: "smx-setting__label" }, "名称"),
          h("input", {
            className: "smx-input smx-input--wide",
            value: newName,
            placeholder: "kebab-case，例如 my-skill",
            onChange: (event) => setNewName(event.target.value),
          }),
        ),
        h("div", { className: "smx-setting__row" },
          h("label", { className: "smx-setting__label" }, "描述"),
          h("input", {
            className: "smx-input smx-input--wide",
            value: newDesc,
            placeholder: "一句话说明这个技能什么时候用",
            onChange: (event) => setNewDesc(event.target.value),
          }),
        ),
        h("div", { className: "smx-setting__save" },
          h("button", { type: "button", className: "smx-btn", onClick: () => setCreating(false) }, "取消"),
          h("button", { type: "button", className: "smx-btn smx-btn--primary", onClick: create }, "创建"),
        ),
      ) : null,
      loading ? h(Empty, null, "加载中…")
        : skills.length === 0 ? h(Empty, null, "技能目录里还没有 SKILL.md")
        : visible.length === 0 ? h(Empty, null, "没有匹配「" + query.trim() + "」的技能")
        : h("ul", { className: "smx-list" }, rows),
    );
  }

  // ── 全局 Prompt 面板 ─────────────────────────────────────────────────────
  function PromptPanel() {
    const [files, setFiles] = useState(null);
    const [selected, setSelected] = useState("");
    const [draft, setDraft] = useState("");
    const [original, setOriginal] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");

    const refresh = useCallback(async () => {
      const value = await hub("listPrompts");
      setFiles(value.files);
      return value.files;
    }, []);

    useEffect(() => { refresh().catch((err) => setError(errText(err))); }, [refresh]);

    async function open(file) {
      setNotice("");
      try {
        const doc = await hub("readManagedFile", { path: file.path });
        setSelected(file.path);
        setDraft(doc.content);
        setOriginal(doc.content);
        setError("");
      } catch {
        setSelected(file.path);
        setDraft("");
        setOriginal("");
        setError("");
        setNotice("文件还不存在，保存时会创建：" + file.path);
      }
    }

    async function save() {
      if (!selected) return;
      setSaving(true);
      try {
        await hub("writeManagedFile", { path: selected, content: draft });
        setOriginal(draft);
        setNotice("已保存 " + selected);
        setError("");
        await refresh();
      } catch (err) {
        setError(errText(err));
      } finally {
        setSaving(false);
      }
    }

    const list = h("ul", { className: "smx-list" },
      (files || []).map((file) => h("li", {
        key: file.key,
        className: cx("smx-row", "smx-row--pick", selected === file.path && "is-active"),
        onClick: () => open(file),
      },
        h("div", { className: "smx-row__main" },
          h("div", { className: "smx-row__top" },
            h("span", { className: "smx-row__name" }, file.label),
            file.exists ? null : h(Badge, { tone: "muted" }, "未创建"),
          ),
          h("div", { className: "smx-row__path" }, file.path),
        ),
      )),
    );

    const editor = selected
      ? h("div", { className: "smx" },
          h("div", { className: "smx-head" },
            h("span", { className: "smx-row__path" }, selected),
            h("span", { className: "smx-head__meta" },
              h("span", { className: "smx-count" }, draft === original ? "未修改" : "有未保存的修改"),
              h("button", {
                type: "button",
                className: "smx-btn smx-btn--primary",
                disabled: saving || draft === original,
                onClick: save,
              }, saving ? "保存中…" : "保存"),
            ),
          ),
          h("textarea", {
            className: "smx-editor",
            value: draft,
            spellCheck: false,
            onChange: (event) => setDraft(event.target.value),
          }),
        )
      : h(Empty, null, "从左侧选择一个全局指令文件");

    return h("div", { className: "smx" },
      notice ? h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice) : null,
      error ? h(Notice, { kind: "error", onDismiss: () => setError("") }, error) : null,
      h("div", { className: "smx-split" },
        files === null ? h(Empty, null, "加载中…") : list,
        editor,
      ),
    );
  }

  // ── 文件面板 ─────────────────────────────────────────────────────────────
  function FilesPanel() {
    const [roots, setRoots] = useState([]);
    const [listing, setListing] = useState(null);
    const [openPath, setOpenPath] = useState("");
    const [draft, setDraft] = useState("");
    const [original, setOriginal] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");

    useEffect(() => {
      (async () => {
        try {
          const list = await hub("listRoots");
          setRoots(list);
          setListing(await hub("listDir", { path: list[0].path }));
        } catch (err) {
          setError(errText(err));
        }
      })();
    }, []);

    async function go(path) {
      try {
        setOpenPath("");
        setListing(await hub("listDir", { path }));
        setError("");
      } catch (err) {
        setError(errText(err));
      }
    }

    async function openFile(entry) {
      try {
        const doc = await hub("readManagedFile", { path: entry.path });
        setOpenPath(entry.path);
        setDraft(doc.content);
        setOriginal(doc.content);
        setError("");
        setNotice("");
      } catch (err) {
        setError(errText(err));
      }
    }

    async function save() {
      setSaving(true);
      try {
        await hub("writeManagedFile", { path: openPath, content: draft });
        setOriginal(draft);
        setNotice("已保存 " + openPath);
        setError("");
      } catch (err) {
        setError(errText(err));
      } finally {
        setSaving(false);
      }
    }

    async function remove(entry) {
      if (typeof window !== "undefined" && !window.confirm("删除 " + entry.name + "？")) return;
      try {
        await hub("deleteManagedFile", { path: entry.path });
        setNotice("已删除 " + entry.name);
        await go(listing ? listing.path : roots[0].path);
      } catch (err) {
        setError(errText(err));
      }
    }

    const entries = listing ? listing.entries : [];
    const listingView = h("div", { className: "smx" },
      h("div", { className: "smx-pathbar" },
        h("span", { className: "smx-row__path", title: listing ? listing.path : "" },
          listing ? listing.path : ""),
        h("button", {
          type: "button",
          className: "smx-btn",
          disabled: !listing || !listing.parent,
          onClick: () => go(listing.parent),
        }, "上级"),
      ),
      h("ul", { className: "smx-list" },
        entries.map((entry) => h("li", { key: entry.path, className: "smx-row" },
          h("div", { className: "smx-row__main", style: { cursor: entry.isDirectory ? "pointer" : "default" } },
            h("div", { className: "smx-row__top" },
              h("span", {
                className: "smx-row__name",
                onClick: () => (entry.isDirectory ? go(entry.path) : openFile(entry)),
                style: { cursor: "pointer" },
              }, (entry.isDirectory ? "\uD83D\uDCC1 " : "\uD83D\uDCC4 ") + entry.name),
              openPath === entry.path ? h(Badge, { tone: "info" }, "编辑中") : null,
            ),
            h("div", { className: "smx-row__path" }, entry.isDirectory ? "目录" : String(entry.size ?? "") + " bytes"),
          ),
          h("div", { className: "smx-row__actions" },
            entry.isDirectory ? null : h("button", { type: "button", className: "smx-btn", onClick: () => openFile(entry) }, "打开"),
            h("button", { type: "button", className: "smx-btn smx-btn--ghost", onClick: () => remove(entry) }, "删"),
          ),
        )),
      ),
    );

    const editor = openPath
      ? h("div", { className: "smx" },
          h("div", { className: "smx-head" },
            h("span", { className: "smx-row__path" }, openPath),
            h("span", { className: "smx-head__meta" },
              h("span", { className: "smx-count" }, draft === original ? "未修改" : "有未保存的修改"),
              h("button", {
                type: "button",
                className: "smx-btn smx-btn--primary",
                disabled: saving || draft === original,
                onClick: save,
              }, saving ? "保存中…" : "保存"),
            ),
          ),
          h("textarea", {
            className: "smx-editor",
            value: draft,
            spellCheck: false,
            onChange: (event) => setDraft(event.target.value),
          }),
        )
      : h(Empty, null, "点一个文件开始编辑（受控根目录内）");

    return h("div", { className: "smx" },
      h("div", { className: "smx-head" },
        h("span", { className: "smx-head__meta" },
          roots.map((root) => h("button", {
            key: root.key,
            type: "button",
            className: "smx-btn smx-btn--ghost",
            onClick: () => go(root.path),
          }, root.label)),
        ),
      ),
      notice ? h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice) : null,
      error ? h(Notice, { kind: "error", onDismiss: () => setError("") }, error) : null,
      h("div", { className: "smx-split" }, listing ? listingView : h(Empty, null, "加载中…"), editor),
    );
  }

  // ── MCP panel ────────────────────────────────────────────────────────────
  const TIERS = ["eager", "on-demand", "disabled"];
  const TIER_LABEL = { "eager": "常驻", "on-demand": "按需", "disabled": "关闭" };
  const TIER_TONE = { "eager": "success", "on-demand": "info", "disabled": "muted" };

  function McpPanel() {
    const [entries, setEntries] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [reveal, setReveal] = useState(false);
    const [detail, setDetail] = useState("");
    const [confirming, setConfirming] = useState("");
    const [output, setOutput] = useState("");
    const [toolDescMax, setToolDescMax] = useState(150);
    const [toolDescDraft, setToolDescDraft] = useState("150");
    const [bufferMb, setBufferMb] = useState(null);
    const [bufferDraft, setBufferDraft] = useState("");

    const refresh = useCallback(async (rv) => {
      setLoading(true);
      setError("");
      try {
        const data = await getJson("/skill-mcp-manager/mcp" + (rv ? "?reveal=1" : ""));
        setEntries(data.entries || []);
      } catch (err) {
        setError(errText(err));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => { refresh(false); }, [refresh]);

    useEffect(() => {
      getJson("/skill-mcp-manager/settings")
        .then((data) => {
          const value = data.toolDescriptionMaxLength;
          if (typeof value === "number" && value > 0) {
            setToolDescMax(value);
            setToolDescDraft(String(value));
          }
          const mb = data.stdioMaxBufferSizeMb;
          if (typeof mb === "number" && mb > 0) {
            setBufferMb(mb);
            setBufferDraft(String(mb));
          }
        })
        .catch(() => {});
    }, []);

    async function saveToolDesc() {
      const value = Number(toolDescDraft);
      if (!Number.isInteger(value) || value <= 0 || value > 5000) {
        setError("工具描述截断必须是 1–5000 的正整数");
        return;
      }
      try {
        await postJson("/skill-mcp-manager/settings", { toolDescriptionMaxLength: value });
        setToolDescMax(value);
        setNotice("已更新工具描述截断为 " + value);
      } catch (err) {
        setError(errText(err));
      }
    }

    async function saveBufferMb() {
      const text = bufferDraft.trim();
      // Empty clears the override (back to the SDK default of 10 MB).
      const value = text === "" ? null : Number(text);
      if (value !== null && (!Number.isInteger(value) || value <= 0)) {
        setError("stdio 消息上限必须是正整数（MB），留空表示使用 SDK 默认 10 MB");
        return;
      }
      try {
        await postJson("/skill-mcp-manager/settings", { stdioMaxBufferSizeMb: value });
        setBufferMb(value);
        setBufferDraft(value === null ? "" : String(value));
        setNotice(value === null
          ? "已恢复 SDK 默认上限 10 MB；新上限对之后 mcp_load 的连接生效"
          : "已把 stdio 消息上限调到 " + value + " MB；对之后 mcp_load 的连接生效");
      } catch (err) {
        setError(errText(err));
      }
    }

    async function toggleReveal() {
      const next = !reveal;
      setReveal(next);
      await refresh(next);
    }

    async function setTier(entry, tier) {
      try {
        const upgrading = entry.tier === "on-demand" && tier === "eager";
        await postJson("/skill-mcp-manager/mcp/tier", { name: entry.name, tier });
        setNotice(upgrading ? "已升至 eager（运行中注册，前缀失效一次）" : "已切换 \u300c" + entry.name + "\u300d 到 " + tier);
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    async function setToolEnabled(entry, tool, enabled) {
      try {
        await postJson("/skill-mcp-manager/mcp/tool-tier", {
          name: entry.name,
          tool: tool.name,
          enabled,
        });
        setNotice("已" + (enabled ? "启用 " : "禁用 ") + entry.name + "/" + tool.name);
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    async function run(entry, peek) {
      setOutput("");
      try {
        const data = await postJson("/skill-mcp-manager/mcp/load", { name: entry.name, peek: peek === true });
        setOutput(data.text || "");
        setNotice(peek ? "已查看描述" : "已刷新快照");
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    async function remove(entry) {
      setConfirming("");
      try {
        await postJson("/skill-mcp-manager/mcp/delete", { name: entry.name });
        setNotice("已删除 " + entry.name);
        setDetail("");
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    function envRows(entry) {
      const keys = Object.keys(entry.env || {});
      if (keys.length === 0) return null;
      return h("div", { className: "smx-detail__section" },
        h("div", { className: "smx-detail__label" }, "环境变量"),
        keys.map((k) => kv(k, entry.env[k])),
      );
    }

    function headerRows(entry) {
      const keys = Object.keys(entry.headers || {});
      if (keys.length === 0) return null;
      return h("div", { className: "smx-detail__section" },
        h("div", { className: "smx-detail__label" }, "Headers"),
        keys.map((k) => kv(k, entry.headers[k])),
      );
    }

    function toolsSection(entry) {
      if (!entry.tools || entry.tools.length === 0) {
        return h("div", { className: "smx-detail__section" },
          h("div", { className: "smx-detail__label" }, "工具"),
          h(Empty, null, "无工具快照（请刷新快照）"),
        );
      }
      return h("div", { className: "smx-detail__section" },
        h("div", { className: "smx-detail__label" }, "工具 (" + entry.tools.length + ")"),
        h("ul", { className: "smx-tools" },
          entry.tools.map((tool) => h("li", {
            key: tool.name,
            className: cx("smx-tool", tool.enabled === false && "is-disabled"),
          },
            h("select", {
              className: cx("smx-tool__tier", tool.enabled === false && "is-disabled"),
              value: tool.enabled === false ? "disabled" : "enabled",
              "aria-label": tool.name + " 档位",
              onChange: (event) => setToolEnabled(entry, tool, event.target.value === "enabled"),
            },
              h("option", { value: "enabled" }, "启用"),
              h("option", { value: "disabled" }, "禁用"),
            ),
            h("span", { className: "smx-tool__name" }, tool.name),
            tool.description ? h("span", { className: "smx-tool__desc" }, tool.description) : null,
          )),
        ),
      );
    }

    function detailBlock(entry) {
      return h("div", { className: "smx-detail" },
        h("div", { className: "smx-detail__section" },
          h("div", { className: "smx-detail__label" }, "档位"),
          h("select", {
            className: "smx-select",
            value: entry.tier,
            onChange: (e) => setTier(entry, e.target.value),
          }, TIERS.map((t) => h("option", { key: t, value: t }, TIER_LABEL[t] + " (" + t + ")"))),
        ),
        kv("传输", entry.transport),
        entry.serverDescription ? kv("描述", entry.serverDescription) : null,
        entry.serverName ? kv("服务器自报名", entry.serverName) : null,
        entry.serverVersion ? kv("版本", entry.serverVersion) : null,
        entry.serverTitle ? kv("标题", entry.serverTitle) : null,
        entry.websiteUrl ? kv("网站", entry.websiteUrl) : null,
        entry.command !== null && entry.command !== undefined ? kv("命令", entry.command) : null,
        (entry.args || []).length > 0 ? kv("参数", (entry.args || []).join(" ")) : null,
        entry.url ? kv("URL", entry.url) : null,
        entry.cwd ? kv("工作目录", entry.cwd) : null,
        entry.instructions ? kv("使用说明", entry.instructions) : null,
        entry.notes ? kv("备注", entry.notes) : null,
        entry.lastLoadAt ? kv("上次刷新快照", entry.lastLoadAt) : null,
        envRows(entry),
        headerRows(entry),
        toolsSection(entry),
        h("div", { className: "smx-detail__actions" },
          h("button", { type: "button", className: "smx-btn", onClick: () => run(entry, true) }, "查看描述"),
          h("button", { type: "button", className: "smx-btn", onClick: () => run(entry, false) }, "刷新快照"),
        ),
        output ? h("pre", { className: "smx-output" }, output) : null,
      );
    }

    const rows = (entries || []).map((entry) => {
      const isOpen = detail === entry.name;
      return h("li", { key: entry.name, className: "smx-row smx-row--col" },
        h("div", { className: "smx-row__main" },
          h("div", { className: "smx-row__top" },
            h("span", { className: "smx-row__name" }, entry.name),
            h(Badge, { tone: TIER_TONE[entry.tier] || "muted" }, TIER_LABEL[entry.tier] || entry.tier),
            entry.connectFailed ? h(Badge, { tone: "muted" }, "连接失败，按按需处理") : null,
            entry.transport ? h("span", { className: "smx-row__meta" }, entry.transport) : null,
            h("span", { className: "smx-row__meta" }, entry.toolCount + " 工具"),
          ),
          entry.serverDescription ? h("div", { className: "smx-row__desc" }, entry.serverDescription) : null,
        ),
        h("div", { className: "smx-row__actions" },
          h("button", { type: "button", className: "smx-btn", onClick: () => setDetail(isOpen ? "" : entry.name) }, isOpen ? "收起" : "详情"),
          confirming === entry.name
            ? h("span", { className: "smx-confirm" },
                h("button", { type: "button", className: "smx-btn smx-btn--danger", onClick: () => remove(entry) }, "确认删除条目"),
                h("button", { type: "button", className: "smx-btn", onClick: () => setConfirming("") }, "取消"),
              )
            : h("button", { type: "button", className: "smx-btn smx-btn--ghost", onClick: () => setConfirming(entry.name) }, "删除"),
        ),
        isOpen ? detailBlock(entry) : null,
      );
    });

    return h("div", { className: "smx" },
      h("div", { className: "smx-head" },
        h("span", { className: "smx-count" }, entries ? String(entries.length) + " 个服务器" : ""),
        h("div", { className: "smx-head__meta" },
          h("button", { type: "button", className: "smx-btn", onClick: toggleReveal }, reveal ? "隐藏密钥" : "显示密钥"),
          h("button", { type: "button", className: "smx-btn", onClick: () => refresh(reveal) }, "刷新"),
        ),
      ),
      h("div", { className: "smx-setting" },
        h("span", { className: "smx-setting__label" }, "工具描述截断（字符）"),
        h("input", {
          type: "number",
          className: "smx-input",
          value: toolDescDraft,
          min: 1,
          max: 5000,
          onChange: (e) => setToolDescDraft(e.target.value),
        }),
        h("button", { type: "button", className: "smx-btn", onClick: saveToolDesc }, "保存"),
        h("span", { className: "smx-count" }, "当前 " + toolDescMax),
      ),
      h("div", { className: "smx-setting" },
        h("span", { className: "smx-setting__label" }, "stdio 消息上限（MB）"),
        h("input", {
          type: "number",
          className: "smx-input",
          value: bufferDraft,
          min: 1,
          placeholder: "SDK 默认 10",
          onChange: (e) => setBufferDraft(e.target.value),
        }),
        h("button", { type: "button", className: "smx-btn", onClick: saveBufferMb }, "保存"),
        h("span", { className: "smx-count" },
          bufferMb === null ? "当前 SDK 默认 10 MB；超出上限的消息会被丢弃并报错，连接不断开" : "当前 " + bufferMb + " MB"),
      ),
      notice ? h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice) : null,
      error ? h(Notice, { kind: "error", onDismiss: () => setError("") }, error) : null,
      loading ? h(Empty, null, "加载中\u2026")
        : entries && entries.length === 0 ? h(Empty, null, "没有已注册的 MCP 服务器")
        : h("ul", { className: "smx-list" }, rows),
    );
  }

  // ── MCP 页签：引擎面板 + 新增/修改 ───────────────────────────────────────
  function parsePairs(text) {
    const out = {};
    String(text || "").split(/[\n,]/).forEach((line) => {
      const idx = line.indexOf("=");
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key) out[key] = value;
      }
    });
    return Object.keys(out).length > 0 ? out : undefined;
  }

  function McpAddCard(props) {
    const [name, setName] = useState("");
    const [tier, setTier] = useState("on-demand");
    const [transport, setTransport] = useState("stdio");
    const [command, setCommand] = useState("");
    const [argsText, setArgsText] = useState("");
    const [cwd, setCwd] = useState("");
    const [envText, setEnvText] = useState("");
    const [url, setUrl] = useState("");
    const [headersText, setHeadersText] = useState("");
    const [notes, setNotes] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [open, setOpen] = useState(false);

    async function save() {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const payload = { name: name.trim(), tier, transport };
        if (!payload.name) throw new Error("先填服务器名（[A-Za-z0-9_-]，模型侧命名空间）");
        if (transport === "stdio") {
          payload.command = command.trim();
          const args = argsText.split(/\s+/).map((item) => item.trim()).filter(Boolean);
          if (args.length > 0) payload.args = args;
          if (cwd.trim()) payload.cwd = cwd.trim();
          const env = parsePairs(envText);
          if (env) payload.env = env;
        } else {
          payload.url = url.trim();
          const headers = parsePairs(headersText);
          if (headers) payload.headers = headers;
        }
        if (notes.trim()) payload.notes = notes.trim();
        const value = await hub("mcpRegister", payload);
        setNotice("已保存 " + value.name + "：" + String(value.text || "").slice(0, 160));
        if (props.onSaved) props.onSaved();
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusy(false);
      }
    }

    if (!open) {
      return h("div", { className: "smx-head" },
        h("span", { className: "smx-count" }, "新增或修改服务器"),
        h("button", { type: "button", className: "smx-btn", onClick: () => setOpen(true) }, "＋ 添加 / 编辑"),
      );
    }

    return h("div", { className: "smx-setting smx-setting--block" },
      h("div", { className: "smx-setting__row" },
        h("label", { className: "smx-setting__label" }, "名字"),
        h("input", {
          className: "smx-input smx-input--wide",
          value: name,
          placeholder: "例如 fetch / my-db（已存在 = 修改它）",
          onChange: (event) => setName(event.target.value),
        }),
      ),
      h("div", { className: "smx-setting__row" },
        h("label", { className: "smx-setting__label" }, "档位"),
        h("select", {
          className: "smx-select",
          value: tier,
          onChange: (event) => setTier(event.target.value),
        },
          h("option", { value: "on-demand" }, "按需（推荐，省 token）"),
          h("option", { value: "eager" }, "常驻（直接注册成工具）"),
          h("option", { value: "disabled" }, "关闭"),
        ),
        h("label", { className: "smx-setting__label" }, "传输"),
        h("select", {
          className: "smx-select",
          value: transport,
          onChange: (event) => setTransport(event.target.value),
        },
          h("option", { value: "stdio" }, "stdio"),
          h("option", { value: "streamable-http" }, "streamable-http"),
        ),
      ),
      transport === "stdio" ? h("div", null,
        h("div", { className: "smx-setting__row" },
          h("label", { className: "smx-setting__label" }, "命令"),
          h("input", {
            className: "smx-input smx-input--wide",
            value: command,
            placeholder: "例如 npx / uvx / node",
            onChange: (event) => setCommand(event.target.value),
          }),
        ),
        h("div", { className: "smx-setting__row" },
          h("label", { className: "smx-setting__label" }, "参数"),
          h("input", {
            className: "smx-input smx-input--wide",
            value: argsText,
            placeholder: "空格分隔，例如 -y @modelcontextprotocol/server-fetch",
            onChange: (event) => setArgsText(event.target.value),
          }),
        ),
        h("div", { className: "smx-setting__row" },
          h("label", { className: "smx-setting__label" }, "工作目录"),
          h("input", {
            className: "smx-input smx-input--wide",
            value: cwd,
            placeholder: "可选，绝对路径",
            onChange: (event) => setCwd(event.target.value),
          }),
        ),
        h("div", { className: "smx-setting__row" },
          h("label", { className: "smx-setting__label" }, "环境变量"),
          h("input", {
            className: "smx-input smx-input--wide",
            value: envText,
            placeholder: "K=V，多个用逗号分隔；值可写 $VAR 引用进程环境",
            onChange: (event) => setEnvText(event.target.value),
          }),
        ),
      ) : h("div", null,
        h("div", { className: "smx-setting__row" },
          h("label", { className: "smx-setting__label" }, "URL"),
          h("input", {
            className: "smx-input smx-input--wide",
            value: url,
            placeholder: "https://…/mcp/",
            onChange: (event) => setUrl(event.target.value),
          }),
        ),
        h("div", { className: "smx-setting__row" },
          h("label", { className: "smx-setting__label" }, "请求头"),
          h("input", {
            className: "smx-input smx-input--wide",
            value: headersText,
            placeholder: "Authorization=Bearer xxx，多个用逗号分隔",
            onChange: (event) => setHeadersText(event.target.value),
          }),
        ),
      ),
      h("div", { className: "smx-setting__row" },
        h("label", { className: "smx-setting__label" }, "备注"),
        h("input", {
          className: "smx-input smx-input--wide",
          value: notes,
          placeholder: "可选：只你自己看，不会被服务器更新覆盖",
          onChange: (event) => setNotes(event.target.value),
        }),
      ),
      error ? h(Notice, { kind: "error", onDismiss: () => setError("") }, error) : null,
      notice ? h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice) : null,
      h("div", { className: "smx-setting__save" },
        h("span", { className: "smx-count" }, "保存前会试连一次（约 30s）验证工具列表；只改档位/备注不会试连"),
        h("button", { type: "button", className: "smx-btn", onClick: () => setOpen(false) }, "收起"),
        h("button", {
          type: "button",
          className: "smx-btn smx-btn--primary",
          disabled: busy,
          onClick: save,
        }, busy ? "保存中…" : "保存"),
      ),
    );
  }

  function McpTab() {
    const [version, setVersion] = useState(0);
    return h("div", { className: "smx" },
      h(PluginSettings),
      h(McpPanel, { key: version }),
      h(McpAddCard, { onSaved: () => setVersion((value) => value + 1) }),
    );
  }

  // ── capability section (tabs: 技能 / MCP) ────────────────────────────────
  const APPROVAL_OPTIONS = [
    ["follow", "跟随当前对话的 DSH 权限"],
    ["always-ask", "每次都问"],
    ["always-allow", "始终放行"],
  ];

  function PluginSettings() {
    const [approval, setApproval] = useState("follow");
    const [hosts, setHosts] = useState("");
    const [notice, setNotice] = useState("");
    const [error, setError] = useState("");

    useEffect(() => {
      getJson("/skill-mcp-manager/settings")
        .then((data) => {
          if (typeof data.localCommandApproval === "string") setApproval(data.localCommandApproval);
          if (Array.isArray(data.lanHostAllowlist)) setHosts(data.lanHostAllowlist.join(", "));
        })
        .catch(() => {});
    }, []);

    async function save() {
      const lanHostAllowlist = hosts.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
      try {
        const data = await postJson("/skill-mcp-manager/settings", { localCommandApproval: approval, lanHostAllowlist });
        if (typeof data.localCommandApproval === "string") setApproval(data.localCommandApproval);
        setHosts(Array.isArray(data.lanHostAllowlist) ? data.lanHostAllowlist.join(", ") : "");
        setNotice("已保存");
        setError("");
      } catch (err) {
        setError(errText(err));
      }
    }

    return h("div", { className: "smx-setting smx-setting--block" },
      h("div", { className: "smx-setting__row" },
        h("label", { className: "smx-setting__label" }, "模型登记本地程序"),
        h("select", {
          className: "smx-select",
          value: approval,
          onChange: (event) => setApproval(event.target.value),
        }, APPROVAL_OPTIONS.map((option) => h("option", { key: option[0], value: option[0] }, option[1]))),
      ),
      h("div", { className: "smx-setting__row" },
        h("label", { className: "smx-setting__label" }, "局域网主机名"),
        h("input", {
          className: "smx-input smx-input--wide",
          value: hosts,
          placeholder: "默认空。只有用电脑名打开时才填写",
          onChange: (event) => setHosts(event.target.value),
        }),
      ),
      h("div", { className: "smx-setting__save" },
        error ? h("span", { className: "smx-count" }, error) : null,
        notice ? h("span", { className: "smx-count" }, notice) : null,
        h("button", { type: "button", className: "smx-btn", onClick: save }, "保存"),
      ),
    );
  }

  function ManagerSection() {
    const [tab, setTab] = useState("skills");
    const TABS = [
      ["skills", "技能"],
      ["mcp", "MCP"],
      ["prompt", "全局 Prompt"],
      ["files", "文件"],
    ];
    return h("div", { className: "smx" },
      h("header", { className: "smx-header" },
        h("h2", { className: "smx-title" }, "能力库"),
        h("div", { className: "smx-subtitle" }, "Skill、MCP、全局 Prompt 与文件，一个入口管完"),
      ),
      h(LegacySessionBanner),
      h("div", { className: "smx-tabs" },
        TABS.map(([id, label]) => h("button", {
          key: id,
          type: "button",
          className: cx("smx-tab", tab === id && "is-active"),
          onClick: () => setTab(id),
        }, label)),
      ),
      tab === "skills" ? h(HubSkillsPanel) : null,
      tab === "mcp" ? h(McpTab) : null,
      tab === "prompt" ? h(PromptPanel) : null,
      tab === "files" ? h(FilesPanel) : null,
    );
  }

  // ── CSS ──────────────────────────────────────────────────────────────────
  const CSS = [
    ".smx { display:flex; flex-direction:column; gap:12px; min-width:0; }",
    ".smx-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }",
    ".smx-title { margin:0; font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); }",
    ".smx-head__meta { display:flex; align-items:center; gap:8px; }",
    ".smx-setting { display:flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); }",
    ".smx-setting--block { flex-direction:column; align-items:stretch; gap:10px; }",
    ".smx-setting__row { display:flex; align-items:center; gap:8px; min-width:0; }",
    ".smx-setting__save { display:flex; justify-content:flex-end; align-items:center; gap:8px; }",
    ".smx-setting__label { flex:none; white-space:nowrap; font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-input { font-size:12px; padding:5px 8px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); width:72px; }",
    ".smx-input--wide { width:auto; flex:1; min-width:0; }",
    ".smx-count { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-btn { font-size:12px; line-height:1; padding:6px 10px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); cursor:pointer; }",
    ".smx-btn:hover { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }",
    ".smx-btn--ghost { border-color:var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }",
    ".smx-btn--danger { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }",
    ".smx-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }",
    ".smx-row { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:10px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); }",
    ".smx-row--col { flex-direction:column; }",
    ".smx-row__main { min-width:0; flex:1; }",
    ".smx-row__top { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }",
    ".smx-row__name { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }",
    ".smx-row__path { font-size:11px; color:var(--dsw-alias-label-secondary); word-break:break-all; }",
    ".smx-row__meta { font-size:11px; color:var(--dsw-alias-label-secondary); }",
    ".smx-row__desc { margin-top:4px; font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-row__actions { display:flex; align-items:center; gap:8px; flex-shrink:0; }",
    ".smx-switchline { display:flex; align-items:center; gap:6px; }",
    ".smx-switchline__label { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-switch { position:relative; width:30px; height:17px; border-radius:999px; border:none; background:var(--dsw-alias-border-l2); cursor:pointer; padding:0; flex-shrink:0; }",
    ".smx-switch.is-on { background:var(--dsw-alias-brand-primary); }",
    ".smx-switch__knob { position:absolute; top:2px; left:2px; width:13px; height:13px; border-radius:50%; background:#fff; transition:left .12s ease; }",
    ".smx-switch.is-on .smx-switch__knob { left:15px; }",
    ".smx-badge { font-size:10px; padding:2px 6px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-secondary); white-space:nowrap; }",
    ".smx-badge--success { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }",
    ".smx-badge--info { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }",
    ".smx-badge--muted { color:var(--dsw-alias-label-secondary); border-color:var(--dsw-alias-border-l1); }",
    ".smx-notice { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; border-radius:6px; font-size:12px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }",
    ".smx-notice--success { border-color:var(--dsw-alias-state-success-primary); }",
    ".smx-notice--error { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }",
    ".smx-notice__close { border:none; background:none; color:inherit; cursor:pointer; font-size:14px; padding:0 2px; }",
    ".smx-legacy { display:flex; flex-direction:column; gap:4px; line-height:1.6; text-align:left; }",
    ".smx-legacy__title { font-weight:600; }",
    ".smx-legacy__code { font-family:var(--ds-font-family-code); font-size:11px; padding:1px 4px; border-radius:4px; background:var(--dsw-alias-bg-layer-2); }",
    ".smx-legacy__link { color:var(--dsw-alias-brand-primary); }",
    ".smx-legacy__note { color:var(--dsw-alias-label-secondary); }",
    // The shell overlay layer is a pointer-events:none frame-sized layer whose
    // direct children stay interactive, so the toast sizes and anchors itself.
    ".smx-toast { position:absolute; right:16px; bottom:16px; display:flex; align-items:flex-start; gap:10px; max-width:360px; padding:10px 12px; border-radius:10px; border:1px solid var(--dsw-alias-state-error-primary); background:var(--dsw-alias-bg-layer-1); box-shadow:0 8px 28px rgba(0,0,0,.18); pointer-events:auto; }",
    ".smx-toast--checking { border-color:var(--dsw-alias-border-l2); }",
    ".smx-toast--ok { border-color:var(--dsw-alias-state-success-primary); }",
    ".smx-toast__main { min-width:0; }",
    ".smx-toast__title { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }",
    ".smx-toast__text { margin-top:4px; font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-toast__close { border:none; background:none; color:var(--dsw-alias-label-secondary); cursor:pointer; font-size:15px; line-height:1; padding:0 2px; }",
    ".smx-empty { padding:18px; text-align:center; font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-confirm { display:inline-flex; gap:6px; align-items:center; }",
    ".smx-detail { display:flex; flex-direction:column; gap:8px; border-top:1px solid var(--dsw-alias-border-l1); padding-top:10px; }",
    ".smx-detail__section { display:flex; flex-direction:column; gap:4px; }",
    ".smx-detail__label { font-size:11px; font-weight:600; color:var(--dsw-alias-label-secondary); }",
    ".smx-detail__actions { display:flex; gap:8px; flex-wrap:wrap; }",
    ".smx-kv { display:flex; gap:8px; font-size:12px; }",
    ".smx-kv__k { flex-shrink:0; color:var(--dsw-alias-label-secondary); }",
    ".smx-kv__v { color:var(--dsw-alias-label-primary); word-break:break-all; }",
    ".smx-select { font-size:12px; padding:5px 8px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }",
    ".smx-tools { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px; }",
    ".smx-tool { display:flex; align-items:flex-start; gap:8px; font-size:12px; }",
    ".smx-tool__tier { flex-shrink:0; min-width:58px; font-size:11px; padding:2px 4px; border-radius:5px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }",
    ".smx-tool__tier.is-disabled { color:var(--dsw-alias-label-secondary); }",
    ".smx-tool__name { font-family:ui-monospace,monospace; color:var(--dsw-alias-label-primary); flex-shrink:0; }",
    ".smx-tool__desc { color:var(--dsw-alias-label-secondary); }",
    ".smx-tool.is-disabled .smx-tool__name, .smx-tool.is-disabled .smx-tool__desc { color:var(--dsw-alias-label-secondary); }",
    ".smx-output { margin:0; padding:8px; border-radius:6px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-size:11px; white-space:pre-wrap; word-break:break-word; max-height:220px; overflow:auto; }",
    ".smx-header { display:flex; flex-direction:column; gap:2px; }",
    ".smx-subtitle { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-tabs { display:flex; gap:4px; border-bottom:1px solid var(--dsw-alias-border-l1); padding-bottom:8px; }",
    ".smx-tab { font-size:12px; padding:6px 12px; border-radius:6px; border:1px solid transparent; background:none; color:var(--dsw-alias-label-secondary); cursor:pointer; }",
    ".smx-tab.is-active { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); }",
    ".smx-row__head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; min-width:0; }",
    ".smx-row--pick { cursor:pointer; }",
    ".smx-row--pick.is-active { border-color:var(--dsw-alias-brand-primary); }",
    ".smx-btn--primary { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }",
    ".smx-btn:disabled { opacity:.5; cursor:default; }",
    ".smx-edit { display:flex; flex-direction:column; gap:8px; margin-top:10px; }",
    ".smx-edit__bar { display:flex; align-items:center; justify-content:flex-end; gap:8px; }",
    ".smx-editor { width:100%; box-sizing:border-box; min-height:320px; resize:vertical; padding:10px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font-family:var(--ds-font-family-code); font-size:12px; line-height:1.6; }",
    ".smx-split { display:grid; grid-template-columns:minmax(220px, 320px) minmax(0, 1fr); gap:12px; align-items:start; }",
    ".smx-pathbar { display:flex; align-items:center; justify-content:space-between; gap:8px; }",
  ].join("\n");

  function injectCss() {
    if (typeof document === "undefined") return;
    const tagId = "dsh-hub";
    if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-hub";
    tag.dataset.pluginCss = tagId;
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }

  // ── apply ────────────────────────────────────────────────────────────────
  function apply(ctx) {
    injectCss();
    // 引擎包的 dsh.client 会随它的 host 行一起挂载（内核按挂载的包收集 client），
    // 所以它的「能力库」页签一定存在。这里用 priority: -1 覆盖同一 id 的渲染
    // （内核约定：priority 最低者渲染），得到的仍是单一入口，内容是融合后的四个页签。
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "capability",
      order: 35,
      priority: -1,
      label: "能力库",
    }, ManagerSection));
    // Frame-wide notices belong in the shell overlay, not in a settings page:
    // `shell.overlay` is a root-scope `list` slot rendered with no props inside
    // the frame's pointer-events:none layer, so the occupant positions itself
    // and everything around it stays click-through.
    ctx.slots.inject("shell.overlay", () => ctx.slots.register({
      name: "shell.overlay",
      id: "capability-legacy-sessions",
      order: 80,
      priority: -1,
    }, LegacySessionOverlay));
  }

  return { name, inject, apply };
}});
