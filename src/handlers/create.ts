import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard, requireOwner } from "../toolkit/index.js";
import { getDraft, getSubscriber, listSent, now, saveDraft, saveSent, subscribedIds, type Draft } from "../domain-store.js";

const composer = new Composer<Ctx>();
const menu = (rows: ReturnType<typeof inlineButton>[][]) => inlineKeyboard(rows);
const cancelRow = [inlineButton("Cancel", "broadcast:cancel")];
registerMainMenuItem({ label: "📣 Broadcasts", data: "broadcast:open", order: 30 });

function draftFromSession(ctx: Ctx): Draft {
  const id = ctx.chat?.id ?? 0;
  return {
    draft_id: ctx.session.draftId ?? String(id),
    created_by_admin_chat_id: id,
    created_at: now().toISOString(),
    message_type: ctx.session.messageType ?? "text",
    text_content: ctx.session.textContent,
    image_file_id: ctx.session.imageFileId,
    caption: ctx.session.caption,
    quick_buttons: ctx.session.quickButtons ?? [],
    target_mode: ctx.session.targetMode ?? "all",
    status: "editing",
  };
}

async function saveCurrent(ctx: Ctx): Promise<Draft> {
  const draft = draftFromSession(ctx);
  await saveDraft(ctx, draft);
  return draft;
}

async function preview(ctx: Ctx): Promise<void> {
  const draft = await saveCurrent(ctx);
  const target = draft.target_mode === "all" ? "all subscribers" : `${draft.custom_target_list?.length ?? 0} selected chats`;
  const actions = menu([[inlineButton("Edit", "broadcast:edit")], [inlineButton("Send", "broadcast:send"), inlineButton("Cancel", "broadcast:cancel")]]);
  if (draft.message_type === "image" && draft.image_file_id) {
    await ctx.api.sendPhoto(ctx.chat?.id ?? 0, draft.image_file_id, { caption: draft.caption, reply_markup: quickMarkup(draft.quick_buttons) });
    await ctx.reply(`Target: ${target}\nThis is ready to send.`, { reply_markup: actions });
    return;
  }
  await ctx.reply(`Preview\n${draft.text_content ?? ""}\n\nTarget: ${target}${draft.quick_buttons.length ? `\nButtons: ${draft.quick_buttons.join(" · ")}` : ""}`, { reply_markup: actions });
}

composer.command("create", async (ctx) => {
  if (!(await requireOwner(ctx))) return;
  const existing = await getDraft(ctx, ctx.chat?.id ?? 0);
  if (existing && existing.status === "editing") {
    ctx.session.draftId = existing.draft_id;
    ctx.session.messageType = existing.message_type;
    ctx.session.textContent = existing.text_content;
    ctx.session.imageFileId = existing.image_file_id;
    ctx.session.caption = existing.caption;
    ctx.session.quickButtons = existing.quick_buttons;
    ctx.session.targetMode = existing.target_mode;
    ctx.session.customTargetList = existing.custom_target_list;
    await ctx.reply("You have a draft in progress. Choose a message type to continue.", { reply_markup: menu([[inlineButton("Text", "broadcast:type:text"), inlineButton("Image", "broadcast:type:image")], cancelRow]) });
    return;
  }
  ctx.session = { step: "type", draftId: String(ctx.chat?.id ?? 0), quickButtons: [] };
  await ctx.reply("What would you like to send?", { reply_markup: menu([[inlineButton("Text", "broadcast:type:text"), inlineButton("Image", "broadcast:type:image")], cancelRow]) });
});

composer.callbackQuery(/^broadcast:type:(text|image)$/, async (ctx) => {
  if (!(await requireOwner(ctx))) return;
  await ctx.answerCallbackQuery();
  const type = ctx.match[1] as "text" | "image";
  ctx.session.messageType = type; ctx.session.step = type === "text" ? "content" : "caption"; ctx.session.quickButtons = []; await saveCurrent(ctx);
  await ctx.reply(type === "text" ? "Send the message text." : "Send the image, then I’ll ask for its caption.", { reply_markup: menu([cancelRow]) });
});

composer.on("message:photo", async (ctx, next) => {
  if (ctx.session.step !== "caption" || !(await requireOwner(ctx))) return next();
  const photos = ctx.message.photo;
  ctx.session.imageFileId = photos[photos.length - 1]?.file_id;
  ctx.session.step = "caption";
  await ctx.reply("Now send a caption, or send - for no caption.", { reply_markup: menu([cancelRow]) });
});

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;
  if (!step || step === "idle" || !(await requireOwner(ctx))) return next();
  const value = ctx.message.text.trim();
  if (step === "content") {
    if (!value) { await ctx.reply("That message is empty — send a little more text."); return; }
    ctx.session.textContent = value; ctx.session.step = "buttons"; await saveCurrent(ctx);
    await ctx.reply("Add up to 3 button labels, separated by commas. Send none for no buttons.", { reply_markup: menu([cancelRow]) }); return;
  }
  if (step === "caption") {
    if (!ctx.session.imageFileId) { await ctx.reply("I’m waiting for the image first."); return; }
    ctx.session.caption = value === "-" ? undefined : value; ctx.session.step = "buttons"; await saveCurrent(ctx);
    await ctx.reply("Add up to 3 button labels, separated by commas. Send none for no buttons.", { reply_markup: menu([cancelRow]) }); return;
  }
  if (step === "buttons") {
    const labels = value.toLowerCase() === "none" ? [] : value.split(",").map((x) => x.trim()).filter(Boolean);
    if (labels.length > 3) { await ctx.reply("Choose up to 3 buttons — separate their labels with commas."); return; }
    ctx.session.quickButtons = labels; ctx.session.step = "target"; await saveCurrent(ctx);
    await ctx.reply("Who should receive it?", { reply_markup: menu([[inlineButton("All subscribers", "broadcast:target:all")], [inlineButton("Paste chat IDs", "broadcast:target:custom")], cancelRow]) }); return;
  }
  if (step === "target") {
    const parsed = parseIds(value);
    ctx.session.targetMode = "custom_list"; ctx.session.step = "confirm";
    ctx.session = { ...ctx.session, customTargetList: parsed.ids } as typeof ctx.session & { customTargetList?: number[] };
    await saveCurrent(ctx);
    const invalidText = parsed.invalid.length ? `\nCouldn’t use: ${parsed.invalid.join(", ")}` : "";
    await ctx.reply(`I found ${parsed.ids.length} unique chat ID${parsed.ids.length === 1 ? "" : "s"}.${invalidText}\nCheck the preview, then confirm.` , { reply_markup: menu([[inlineButton("Show preview", "broadcast:preview")], cancelRow]) }); return;
  }
  return next();
});

function parseIds(input: string): { ids: number[]; invalid: string[] } {
  const values = input.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  const ids: number[] = []; const invalid: string[] = [];
  for (const value of values) { if (/^-?\d+$/.test(value)) { const id = Number(value); if (Number.isSafeInteger(id) && !ids.includes(id)) ids.push(id); } else invalid.push(value); }
  return { ids, invalid };
}

composer.callbackQuery("broadcast:target:all", async (ctx) => {
  if (!(await requireOwner(ctx))) return; await ctx.answerCallbackQuery(); ctx.session.targetMode = "all"; ctx.session.step = "confirm"; await preview(ctx);
});
composer.callbackQuery("broadcast:target:custom", async (ctx) => {
  if (!(await requireOwner(ctx))) return; await ctx.answerCallbackQuery(); ctx.session.step = "target"; await ctx.reply("Paste chat IDs, one per line or separated by commas.", { reply_markup: menu([cancelRow]) });
});
composer.callbackQuery("broadcast:preview", async (ctx) => { if (!(await requireOwner(ctx))) return; await ctx.answerCallbackQuery(); await preview(ctx); });
composer.callbackQuery("broadcast:edit", async (ctx) => { if (!(await requireOwner(ctx))) return; await ctx.answerCallbackQuery(); ctx.session.step = "type"; await ctx.reply("Let’s edit it. Choose a message type.", { reply_markup: menu([[inlineButton("Text", "broadcast:type:text"), inlineButton("Image", "broadcast:type:image")], cancelRow]) }); });
composer.callbackQuery("broadcast:cancel", async (ctx) => { if (!(await requireOwner(ctx))) return; await ctx.answerCallbackQuery(); const draft = await saveCurrent(ctx); await saveDraft(ctx, { ...draft, status: "cancelled" }); ctx.session = {}; await ctx.reply("Draft cancelled."); });
composer.callbackQuery("broadcast:send", async (ctx) => {
  if (!(await requireOwner(ctx))) return; await ctx.answerCallbackQuery();
  const draft = await saveCurrent(ctx); const targets = draft.target_mode === "all" ? await subscribedIds(ctx) : draft.custom_target_list ?? [];
  await saveDraft(ctx, { ...draft, status: "sending" });
  let sent = 0; let failed = 0; let skipped = 0; const errors: string[] = [];
  for (const target of targets) {
    const current = await getDraft(ctx, ctx.chat?.id ?? 0);
    if (current?.status === "cancelled") break;
    const subscriber = await getSubscriber(ctx, target);
    if (subscriber?.status === "unsubscribed") { skipped++; continue; }
    try {
      if (draft.message_type === "image" && draft.image_file_id) await ctx.api.sendPhoto(target, draft.image_file_id, { caption: draft.caption, reply_markup: quickMarkup(draft.quick_buttons) });
      else await ctx.api.sendMessage(target, draft.text_content ?? "", { reply_markup: quickMarkup(draft.quick_buttons) });
      sent++;
    } catch (error) { failed++; if (errors.length < 3) errors.push(`${target}: delivery failed`); }
    if ((sent + failed) % 10 === 0) await ctx.reply(`Sending updates… ${sent} sent, ${failed} failed.`);
  }
  const id = `${ctx.chat?.id ?? 0}-${now().getTime()}`;
  await saveSent(ctx, { broadcast_id: id, sent_at: now().toISOString(), created_by_admin_chat_id: ctx.chat?.id ?? 0, message_snapshot: { message_type: draft.message_type, text_content: draft.text_content, image_file_id: draft.image_file_id, caption: draft.caption, quick_buttons: draft.quick_buttons, target_mode: draft.target_mode, custom_target_list: draft.custom_target_list }, target_summary: draft.target_mode === "all" ? { all_count: targets.length } : { custom_count: targets.length }, counts_sent: sent, counts_failed: failed, counts_unsubscribed_during_send: skipped, failed_examples: errors, status: failed ? "partial" : "completed" });
  await saveDraft(ctx, { ...draft, status: "ready" });
  await ctx.reply(`Broadcast finished — ${sent} sent, ${failed} failed, ${skipped} unsubscribed during send.`);
});

function quickMarkup(labels: string[]): { inline_keyboard: { text: string; callback_data: string }[][] } | undefined {
  return labels.length ? { inline_keyboard: [labels.map((label, i) => inlineButton(label, `broadcast:button:${i}`))] } : undefined;
}

composer.callbackQuery("broadcast:open", async (ctx) => {
  if (!(await requireOwner(ctx))) return;
  await ctx.answerCallbackQuery();
  await ctx.reply("What would you like to do?", { reply_markup: menu([[inlineButton("Create broadcast", "broadcast:create")], [inlineButton("Send history", "broadcast:history")]]) });
});
composer.callbackQuery("broadcast:create", async (ctx) => {
  if (!(await requireOwner(ctx))) return;
  await ctx.answerCallbackQuery(); ctx.session = { step: "type", draftId: String(ctx.chat?.id ?? 0), quickButtons: [] };
  await ctx.reply("What would you like to send?", { reply_markup: menu([[inlineButton("Text", "broadcast:type:text"), inlineButton("Image", "broadcast:type:image")], cancelRow]) });
});
composer.callbackQuery("broadcast:history", async (ctx) => {
  if (!(await requireOwner(ctx))) return;
  await ctx.answerCallbackQuery();
  const records = await listSent(ctx, ctx.chat?.id ?? 0);
  if (!records.length) { await ctx.reply("No broadcasts yet — create one when you’re ready."); return; }
  await ctx.reply(records.slice(0, 10).map((r) => `${r.sent_at.slice(0, 10)} — ${r.counts_sent} sent, ${r.counts_failed} failed`).join("\n"));
});

export default composer;
