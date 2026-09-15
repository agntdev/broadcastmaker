import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";
import { getSubscriber, now, saveSubscriber } from "../domain-store.js";

registerMainMenuItem({ label: "Unsubscribe", data: "subscribe:opt_out", order: 11 });
const composer = new Composer<Ctx>();
composer.callbackQuery("subscribe:opt_out", async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = ctx.chat?.id;
  if (id !== undefined) {
    const previous = await getSubscriber(ctx, id);
    await saveSubscriber(ctx, { chat_id: id, opt_in_timestamp: previous?.opt_in_timestamp ?? now().toISOString(), opt_out_timestamp: now().toISOString(), language_tag: previous?.language_tag ?? ctx.from?.language_code, status: "unsubscribed", metadata: previous?.metadata });
  }
  await ctx.reply("You’re unsubscribed. You can come back anytime.", { reply_markup: inlineKeyboard([[inlineButton("Subscribe", "subscribe:opt_in")]]) });
});
export default composer;
