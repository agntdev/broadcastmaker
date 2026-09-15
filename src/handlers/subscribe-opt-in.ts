import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { adminChatId, inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";
import { getSubscriber, now, saveSubscriber } from "../domain-store.js";

registerMainMenuItem({ label: "Subscribe", data: "subscribe:opt_in", order: 10 });
const composer = new Composer<Ctx>();
composer.callbackQuery("subscribe:opt_in", async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = ctx.chat?.id;
  if (id === undefined) return;
  const at = now().toISOString();
  await saveSubscriber(ctx, { chat_id: id, opt_in_timestamp: at, opt_out_timestamp: null, language_tag: ctx.from?.language_code, status: "subscribed", metadata: { source: "button" } });
  await ctx.reply("You’re subscribed — you’ll receive community updates here.", { reply_markup: inlineKeyboard([[inlineButton("Unsubscribe", "subscribe:opt_out")]]) });
  const owner = adminChatId(ctx);
  if (owner && String(id) !== owner) await ctx.api.sendMessage(owner, `A new subscriber joined (chat ${id}).`);
});
export default composer;
