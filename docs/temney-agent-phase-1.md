# Temney Agent — implementovaná fáze 1

Tato větev zachovává původní SongCraft Studio beze změny a přidává bezpečný základ pro agenta Temney.

## Co je hotové

Chat v záložce **Asistent** je nyní prezentován jako **Temney Agent**. Umí pracovat s privátním kontextem přihlášeného uživatele, navrhovat další kroky pro kanál, připravit artwork prompt a pomoci s metadaty. Stávající lokální historie pěti konverzací zůstává zachována.

Serverová Edge Function má explicitní pravidla pro ochranu soukromí, zákaz předstírání provedených akcí a human-in-the-loop režim. Veřejné nebo nevratné akce jsou vždy označeny jako návrh čekající na potvrzení.

Prompt pro artwork nyní obsahuje Temney character bible: skrytý obličej, street-worn oděv, urbánní rozpad, desaturovanou filmovou paletu, negativní prostor pro overlay a zákaz čitelného textu v AI obrázku. Text se má doplňovat až následně v aplikaci.

## Co už repozitář obsahoval

Aplikace již měla generování coverů přes bezplatnou frontu, 16:9 YouTube workflow, Supabase Edge Functions a exportní obrazovku. Tato fáze proto nepřidává druhý paralelní renderer ani neukládá tajné klíče do mobilní aplikace.

## Další bezpečný krok

Další fáze může přidat skutečnou function-calling smyčku s nástroji `list_songs`, `extract_lyric_themes`, `generate_song_artwork`, `generate_metadata` a `render_video`. Každý nástroj musí znovu ověřit `user_id` na serveru a citlivé akce musí vytvářet draft nebo pending záznam před potvrzením uživatele.

YouTube OAuth tokeny, service-role klíč a klíče pro AI služby musí zůstat výhradně v Edge Functions nebo workeru. Do mobilního bundle se nesmí dostat.

## Ověření

Po změnách spusťte:

```bash
pnpm check
pnpm test
pnpm lint
```

Nasazení Edge Function je oddělené od mobilního buildu a vyžaduje nakonfigurovaný `GOOGLE_AI_STUDIO_KEY` v Supabase.

