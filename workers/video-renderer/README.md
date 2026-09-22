# Temney video renderer

Worker vyžaduje Node.js 20+, `ffmpeg` a přístup pouze přes serverový `SUPABASE_SERVICE_ROLE_KEY`.

```bash
sudo apt-get install -y ffmpeg
export SUPABASE_URL=https://<project>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<server-only-key>
node worker.mjs
```

Worker atomicky vezme první `agent_videos.render_status = queued`, načte finální audio a artwork z privátního bucketu přes krátkodobý signed URL, vytvoří MP4 1280×720, nahraje jej zpět a nastaví stav `ready`. Při chybě uloží `failed` a text chyby. Klíč nikdy nepatří do mobilního klienta ani do repozitáře.

Pro trvalý běh použij systemd službu nebo Docker na vlastní VM. Pro polling fronty nepoužívej AI plánované relace.
