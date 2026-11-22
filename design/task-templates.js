// #14 の画面見本。変更はこのページを開いている間だけ保持する。
window.SQTaskTemplates = (() => {
  "use strict";
  const { D, first, firstHref, t, icon, esc, openDialog, closeDialog, toast, redraw } = SQ;
  const token = "{対象}";
  const titleLimit = 200;
  const tasks = [
    { title: "{対象} さんのメールアカウントを作る", points: "2", offset: "0", repository: "", body: "初回ログインを確認する", values: ["アカウントの発行"] },
    { title: "{対象} さんをチームのチャットに招待する", points: "1", offset: "1", repository: "", body: "", values: [] },
    { title: "貸し出し用の PC を準備する", points: "2", offset: "", repository: "", body: "", values: [] },
  ];
  const templates = new Map(first ? [] : [
    ["onboarding", {
      name: "新メンバーのオンボーディング", story: "{対象} さんのオンボーディング",
      criteria: "- 初日に必要なアカウントと機材がそろう", body: "", category: "",
      tasks,
    }],
    ["accounts", {
      name: "アカウントとチャットの準備", story: "", criteria: "", body: "", category: "",
      tasks: tasks.slice(0, 2),
    }],
  ]);
  let sequence = 0;

  function field(name, label, value = "", attrs = "") {
    return `<label class="field"><span class="field-label">${label}</span><input class="input" name="${name}" value="${esc(value)}" ${attrs}></label>`;
  }
  function text(name, label, value) {
    return `<label class="field"><span class="field-label">${label}</span><textarea class="textarea" name="${name}" rows="2" maxlength="10000">${esc(value)}</textarea></label>`;
  }
  function select(name, label, options, value = "") {
    return `<label class="field"><span class="field-label">${label}</span><select class="select" name="${name}">${options.map(([id, title]) =>
      `<option value="${esc(id)}"${id === value ? " selected" : ""}>${esc(title)}</option>`).join("")}</select></label>`;
  }
  function options(records, key, blank) {
    return [["", blank], ...Object.entries(records).map(([id, record]) => [id, record[key]])];
  }
  function dialogButtons(label, form, danger = false) {
    return `<button class="btn" type="button" data-close-dialog>やめる</button><button class="btn ${danger ? "is-danger" : "is-primary"}" type="submit" form="${form}">${label}</button>`;
  }
  function blankTask() {
    return { title: "", points: "", body: "", repository: "", offset: "", values: [] };
  }

  function canApply() {
    return D.workspace === "wa" && !D.workspaces.wa?.closed;
  }

  function canReadSettings() {
    const organization = D.organizations.find(({ slug }) => slug === D.organization);
    return D.workspace === "wa" && (D.workspaces.wa?.role === "leader" || organization?.admin);
  }

  function canManage() {
    return canReadSettings() && canApply();
  }

  function settings() {
    return `<div id="task-templates">
      ${templates.size ? `<ul class="order-list">${Array.from(templates, ([id, item]) => `<li>
        <span class="order-main"><span class="order-name">${esc(item.name)}</span><span class="props-note">${item.tasks.length}件</span></span>
        ${canManage() ? `<div class="order-actions">
          <button class="icon-btn" type="button" data-template-edit="${id}" aria-label="${esc(item.name)}を編集" title="編集">${icon("pen")}</button>
          <button class="icon-btn is-danger" type="button" data-template-delete="${id}" aria-label="${esc(item.name)}を削除" title="削除">${icon("trash")}</button>
        </div>` : ""}</li>`).join("")}</ul>` : `<p>${t("taskTemplateEmpty")}</p>`}
      ${canManage() ? `<div class="form-actions"><button class="btn" type="button" data-template-edit="">${icon("plus")}${t("taskTemplate")}を作る</button></div>` : ""}
    </div>`;
  }

  function editTemplate(id) {
    const current = templates.get(id) || { name: "", story: "", criteria: "", body: "", category: "", tasks: [blankTask()] };
    const rows = current.tasks.slice();
    const formId = "template-edit-form";
    openDialog(id ? `${t("taskTemplate")}を編集` : `${t("taskTemplate")}を作る`, `
      <form class="form" id="${formId}">
        ${field("name", "名前", current.name, 'required maxlength="200"')}
        ${field("story", `${t("story")}の題（任意）`, current.story, 'maxlength="200" aria-describedby="template-story-hint"')}
        <p class="field-hint" id="template-story-hint">題が空の場合は、既存の${t("story")}への追加専用になります。題には <code>{対象}</code> が使えます。題を空にして保存すると、受け入れ基準・本文・区分も外れます。</p>
        <details data-template-story-attributes>
          <summary>${t("story")}の属性</summary>
          <fieldset class="form-fields">
            ${text("criteria", "受け入れ基準", current.criteria)}
            ${text("body", "本文", current.body)}
            ${select("category", t("category"), options(D.categories, "name", "なし"), current.category)}
          </fieldset>
        </details>
        <div class="form" data-template-rows></div>
        <div class="form-actions"><button class="btn is-sm" type="button" data-template-add-task aria-describedby="template-item-limit">${icon("plus")}${t("task")}を足す</button>
          <p class="field-hint" id="template-item-limit" hidden>${t("taskTemplateItemLimit")}</p></div>
      </form>`, dialogButtons("保存する", formId));
    const form = document.getElementById(formId);
    const rowList = form.querySelector("[data-template-rows]");
    const addButton = form.querySelector("[data-template-add-task]");
    const storyAttributes = form.querySelector("[data-template-story-attributes]");
    const storyTitle = form.elements.story;
    function syncStoryAttributes() {
      const hasTitle = Boolean(storyTitle.value.trim());
      storyAttributes.hidden = !hasTitle;
      storyAttributes.querySelector("fieldset").disabled = !hasTitle;
    }
    storyTitle.addEventListener("input", syncStoryAttributes);
    syncStoryAttributes();

    function renderRows(openIndex) {
      rowList.innerHTML = rows.map((task, i) => `<fieldset class="form-fields" data-template-row>
        <legend class="field-label">${t("task")} ${i + 1}</legend>
        ${field("title", "題", task.title, 'required maxlength="200"')}
        <div class="form-row">
          ${select("points", t("points"), [["", "未見積もり"], ...[0, 1, 2, 3, 5, 8, 13].map((n) => [String(n), String(n)])], task.points)}
          ${field("offset", "開始日からの日数（0日目から、空は期日なし）", task.offset, 'type="number" min="0" step="1"')}
        </div>
        <details ${i === openIndex ? "open" : ""}>
          <summary>${t("task")}の属性</summary>
          ${select("repository", "リポジトリ", options(D.repositories, "name", "なし"), task.repository)}
          ${text("taskBody", "本文", task.body)}
          ${D.detailFields.map((label, index) => text("value", esc(label), task.values[index] || "")).join("")}
        </details>
        <div class="form-actions">
          <button class="btn is-sm" type="button" data-template-move="-1" ${i === 0 ? "disabled" : ""}>上へ</button>
          <button class="btn is-sm" type="button" data-template-move="1" ${i === rows.length - 1 ? "disabled" : ""}>下へ</button>
          <button class="btn is-sm is-danger" type="button" data-template-remove-task ${rows.length === 1 ? "disabled" : ""}>外す</button>
        </div></fieldset>`).join("");
      addButton.disabled = rows.length === 50;
      form.querySelector("#template-item-limit").hidden = !addButton.disabled;
    }
    function readRows() {
      return Array.from(rowList.children, (row) => {
        const read = (name) => row.querySelector(`[name="${name}"]`).value.trim();
        return {
          title: read("title"), points: read("points"), offset: read("offset"), repository: read("repository"),
          body: read("taskBody"), values: Array.from(row.querySelectorAll('[name="value"]'), (input) => input.value.trim()),
        };
      });
    }
    renderRows();
    form.addEventListener("click", (event) => {
      const button = event.target.closest("[data-template-add-task], [data-template-remove-task], [data-template-move]");
      if (!button) return;
      const row = button.closest("[data-template-row]");
      const index = Array.from(rowList.children).indexOf(row);
      rows.splice(0, rows.length, ...readRows());
      let next;
      if (button === addButton) {
        rows.push(blankTask());
        next = rows.length - 1;
      } else if (button.hasAttribute("data-template-remove-task")) {
        rows.splice(index, 1);
        next = Math.min(index, rows.length - 1);
      } else {
        next = index + Number(button.dataset.templateMove);
        [rows[index], rows[next]] = [rows[next], rows[index]];
      }
      renderRows(row?.querySelector("details").open ? next : undefined);
      rowList.children[next].querySelector('[name="title"]').focus();
    });
    form.addEventListener("input", (event) => event.target.setCustomValidity?.(""));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = new FormData(form);
      const name = values.get("name").trim();
      const story = values.get("story").trim();
      const savedTasks = readRows();
      const empty = savedTasks.findIndex((task) => !task.title);
      const required = !name ? form.elements.name : empty >= 0 ? rowList.children[empty].querySelector('[name="title"]') : null;
      if (required) {
        required.setCustomValidity("題または名前を入力してください。");
        required.reportValidity();
        return;
      }
      const savedId = id || `example-${++sequence}`;
      templates.set(savedId, {
        name, story, criteria: story ? values.get("criteria").trim() : "",
        body: story ? values.get("body").trim() : "", category: story ? values.get("category") : "", tasks: savedTasks,
      });
      closeDialog();
      redraw();
      document.querySelector(`[data-template-edit="${savedId}"]`)?.focus();
      toast("保存しました");
    });
  }

  function deleteTemplate(id) {
    const formId = "template-delete-form";
    openDialog(`${t("taskTemplate")}を削除`, `<form class="form" id="${formId}"><p>「${esc(templates.get(id).name)}」を削除します。作成済みの${t("story")}と${t("task")}は残ります。</p></form>`,
      dialogButtons("削除する", formId, true));
    document.getElementById(formId).addEventListener("submit", (event) => {
      event.preventDefault();
      templates.delete(id);
      closeDialog();
      redraw();
      document.querySelector('[data-template-edit=""]')?.focus();
      toast("削除しました");
    });
  }

  function backlogAction() {
    if (!canApply()) return "";
    return `<div class="form-actions" id="template-apply"><button class="btn" type="button" data-template-apply="">${t("taskTemplate")}から作る</button></div>`;
  }

  function dueDate(start, offset) {
    if (!start || offset === "") return "";
    const date = new Date(`${start}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + Number(offset));
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() <= 9999 ? date.toISOString().slice(0, 10) : null;
  }

  function applyTemplate(fixedStory) {
    const formId = "template-apply-form";
    if (!templates.size) {
      const settingsUrl = new URL(firstHref("settings.html"), location.href);
      settingsUrl.searchParams.set("workspace", D.workspace);
      settingsUrl.hash = "task-templates";
      openDialog(`${t("taskTemplate")}から作る`, `<p>${t("taskTemplateEmpty")}</p>
        ${canManage()
          ? `<div class="form-actions"><a class="btn" href="${esc(settingsUrl.href)}">${t("taskTemplateManage")}</a></div>`
          : `<p>${t("taskTemplateAskLeader")}</p>`}`);
      return;
    }
    const epics = Object.fromEntries(Object.entries(D.epics).filter(([, epic]) => !epic.cleared));
    const stories = Object.fromEntries(Object.entries(D.stories).filter(([, story]) => !story.doneAt && (!story.epic || epics[story.epic])));
    const members = Object.fromEntries(D.members.filter((member) => !member.left).map(({ who }) => [who, D.users[who]]));
    let simulateChange = new URLSearchParams(location.search).get("template-state") === "changed";
    openDialog(fixedStory ? `${t("taskTemplate")}から${t("task")}を足す` : `${t("taskTemplate")}から作る`, `
      <form class="form" id="${formId}" novalidate>
        ${select("template", t("taskTemplate"), Array.from(templates, ([id, item]) => [id, item.name]))}
        <div class="form" data-template-destination></div>
        <div class="form-row">
          ${field("target", "対象", "", 'placeholder="例：架空 太郎" aria-describedby="template-target-hint"')}
          ${field("start", "開始日", D.today, 'type="date" required')}
        </div>
        <p class="field-hint" id="template-target-hint">作る題の <code>{対象}</code> に差し込みます。</p>
        <div data-template-selection></div>
        <p class="callout is-warn" role="alert" tabindex="-1" hidden data-template-changed>${icon("alert")}<span>${t("taskTemplateChanged")}</span></p>
        <section class="panel" aria-labelledby="template-preview-heading">
          <h3 id="template-preview-heading">プレビュー</h3>
          <div data-template-preview></div>
        </section>
      </form>`, `<p class="field-hint" role="status" id="template-apply-problem" hidden></p>${dialogButtons("作る", formId)}`);
    const form = document.getElementById(formId);
    const submit = document.querySelector(`[form="${formId}"]`);
    const status = document.getElementById("template-apply-problem");
    submit.setAttribute("aria-describedby", status.id);
    const selection = form.querySelector("[data-template-selection]");
    const destination = form.querySelector("[data-template-destination]");
    const read = (name) => form.elements[name]?.value || "";
    const template = () => templates.get(read("template"));

    function renderDestination() {
      const addOnly = !template().story;
      destination.innerHTML = fixedStory
        ? `<p class="field-hint">追加先は「${esc(stories[fixedStory].title)}」です。</p>`
        : `${addOnly ? `<p class="field-hint">この${t("taskTemplate")}は既存の${t("story")}への追加専用です。</p>` :
          select("mode", "作り方", [["new", `${t("story")}を新しく作る`], ["add", `既存の${t("story")}に足す`]])}
          <div data-template-new>${select("epic", `親の${t("epic")}（任意）`, options(epics, "title", "なし"))}</div>
          <div data-template-existing>${select("story", `追加先の${t("story")}`, options(stories, "title", "選んでください"))}</div>`;
    }
    function renderSelection() {
      selection.innerHTML = `<fieldset class="form-fields"><legend class="field-label">作る${t("task")}</legend>
        ${template().tasks.map((task, i) => `<div class="form-row">
          <div class="field"><label class="pick-row"><input type="checkbox" name="include" value="${i}" checked><span>${esc(task.title)}</span></label></div>
          ${select(`assignee-${i}`, `${t("task")} ${i + 1} の担当`, options(members, "name", "担当なし"))}
        </div>`).join("")}</fieldset>`;
    }
    function adding() {
      return fixedStory || !template().story || read("mode") === "add";
    }
    function preview() {
      const add = adding();
      if (!fixedStory) {
        destination.querySelector("[data-template-new]").hidden = Boolean(add);
        destination.querySelector("[data-template-existing]").hidden = !add;
      }
      const storyId = fixedStory || read("story");
      const target = read("target").trim();
      const substitute = (title) => target ? title.replaceAll(token, () => target) : title;
      const selected = Array.from(selection.querySelectorAll('[name="include"]'), (input) => {
        form.elements[`assignee-${input.value}`].disabled = !input.checked;
        return input.checked ? Number(input.value) : null;
      });
      const indices = selected.filter((index) => index !== null);
      const titles = indices.map((i) => template().tasks[i].title);
      if (!add) titles.unshift(template().story);
      form.elements.target.required = titles.some((title) => title.includes(token));
      const rows = indices.map((i) => {
        const task = template().tasks[i];
        return { ...task, title: substitute(task.title), due: dueDate(read("start"), task.offset), who: read(`assignee-${i}`) };
      });
      const badTitle = titles.some((title) => Array.from(substitute(title)).length > titleLimit);
      const missingTarget = form.elements.target.required && !target;
      const problem = !rows.length ? t("taskTemplateChooseTask")
        : add && !storyId ? t("taskTemplateChooseDestination")
        : missingTarget ? t("taskTemplateEnterTarget")
        : !read("start") ? t("taskTemplateEnterStart")
        : badTitle ? t("taskTemplateTitleLimit")
        : rows.some((row) => row.due === null) ? t("taskTemplateDueLimit") : "";
      const heading = add ? stories[storyId]?.title || "追加先を選択" : substitute(template().story);
      const epic = add ? null : epics[read("epic")];
      const category = add ? null : D.categories[epic ? epic.cat : template().category];
      const omitted = (!add && !epic && template().category && !category)
        || rows.some((row) => (row.repository && !D.repositories[row.repository])
          || row.values.some((value, i) => value && !D.detailFields[i]));
      form.querySelector("[data-template-preview]").innerHTML = `
        <p><strong>${esc(heading)}</strong></p>
        ${epic ? `<p class="field-hint">親の${t("epic")} ${esc(epic.title)}</p>` : ""}
        ${category ? `<p class="field-hint">${t("category")} ${esc(category.name)}${epic ? "（親から引き継ぎ）" : ""}</p>` : ""}
        ${omitted ? `<p class="callout is-warn">${icon("alert")}<span>${t("taskTemplateOmitted")}</span></p>` : ""}
        ${add ? `<p class="field-hint">既存の${t("story")}の題や本文などはそのままです。</p>` : ""}
        <ol>${rows.map((row) => `<li>${esc(row.title)}<div class="props-note">${esc(row.due || "期日なし")} ・ ${esc(members[row.who]?.name || "担当なし")}</div></li>`).join("")}</ol>`;
      const problemField = problem === t("taskTemplateEnterTarget") ? "target"
        : problem === t("taskTemplateEnterStart") || problem === t("taskTemplateDueLimit") ? "start" : null;
      for (const name of ["target", "start"]) {
        const input = form.elements[name];
        const hint = name === "target" ? "template-target-hint" : "";
        if (name === problemField) {
          input.setAttribute("aria-invalid", "true");
          input.setAttribute("aria-describedby", hint ? `${hint} ${status.id}` : status.id);
        } else {
          input.removeAttribute("aria-invalid");
          if (hint) input.setAttribute("aria-describedby", hint);
          else input.removeAttribute("aria-describedby");
        }
      }
      if (status.textContent !== problem) status.textContent = problem;
      status.hidden = !problem;
      submit.setAttribute("aria-disabled", String(Boolean(problem)));
      return { add, storyId, heading, rows, problem, problemField };
    }
    renderDestination();
    renderSelection();
    preview();
    form.addEventListener("input", (event) => {
      if (event.target.name === "template") {
        renderDestination();
        renderSelection();
      }
      preview();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const { add, storyId, heading, rows, problem, problemField } = preview();
      if (problem) {
        if (problemField) form.elements[problemField].focus();
        return;
      }
      const affected = rows.find((row) => row.who)?.who;
      if (simulateChange && affected) {
        simulateChange = false;
        delete members[affected];
        selection.querySelectorAll(`option[value="${affected}"]`).forEach((option) => option.remove());
        const notice = form.querySelector("[data-template-changed]");
        notice.hidden = false;
        preview();
        notice.focus();
        return;
      }
      const id = add ? storyId : `template-story-${++sequence}`;
      if (!add) {
        const epic = read("epic");
        D.stories[id] = {
          title: heading, epic: epic || null, cat: !epic && D.categories[template().category] ? template().category : null,
          body: template().body.split("\n"), ac: [], acMd: template().criteria,
        };
      }
      for (const row of rows) {
        D.tasks.push({
          id: `template-task-${++sequence}`, title: row.title, ws: D.workspace, story: id,
          who: row.who || null, due: row.due || null, pts: row.points === "" ? null : Number(row.points),
          repo: D.repositories[row.repository] ? row.repository : null, body: row.body.split("\n"), creator: D.me,
          fields: row.values.map((value, i) => value && D.detailFields[i] ? `### ${D.detailFields[i]}\n\n${value}` : "").filter(Boolean).join("\n\n"),
        });
      }
      closeDialog();
      redraw();
      document.querySelector(`[data-template-apply="${fixedStory}"]`)?.focus();
      toast(`${t("task")}を${rows.length}件作りました`);
    });
  }

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-template-apply], [data-template-edit], [data-template-delete]");
    if (!trigger) return;
    if (trigger.hasAttribute("data-template-apply")) {
      if (canApply()) applyTemplate(trigger.dataset.templateApply);
    } else if (canManage() && trigger.hasAttribute("data-template-edit")) editTemplate(trigger.dataset.templateEdit);
    else if (canManage()) deleteTemplate(trigger.dataset.templateDelete);
  });
  return { canApply, canReadSettings, settings, backlogAction };
})();
