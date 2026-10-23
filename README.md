# dsh-veil

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that sends
every DeepSeek model request through [veil](https://github.com/lemonadesaltbagel/veil), a local
privacy proxy. The model sees consistent pseudonyms for your customers' names, emails, phones and
other seeded values. Your machine keeps the real values: dsh's tools run with them, and you read
them in dsh's answers.

```
dsh ──► veil (127.0.0.1, started by this plugin) ──► DeepSeek API
          real values → pseudonyms on the way out
          pseudonyms → real values on the way back (answers, tool calls)
```

## From a real session

A headless dsh session against the live DeepSeek API (`deepseek-flash`), with this plugin installed
from npm. The terminal output is trimmed where marked `[…]`:

```text
$ dsh --profile headless "leonekohler@surfeu.de says her billing page shows the wrong plan. Check app.db with sqlite3 and tell me what happened."
dsh: reasoning:
Let me inspect the schema.
dsh: reasoning:
Now let me look at the data. Note privacy: personal data is pseudonymized. user_jm9e@example.test is the pseudonym. Let me query.
[… 8 more reasoning blocks …]
Checked `app.db` (2 tables: `customers`, `invoices`, 3 customers, 3 invoices, integrity OK, no orphans or duplicates). Here's what's in it for her:

**Her records**

| Source | Plan | Detail |
|---|---|---|
| `customers` id=1 | **pro** | `leonekohler@surfeu.de`, the only row for that email |
| invoice 290 | pro | $19.00, 2026-09-01 |
| invoice 291 | **free** | $0.00, 2026-10-01 |

[…] So the DB holds two different answers to "what plan is she on": `customers.plan = 'pro'`, but her most recent billing event says `free`.
[…]
```

The model ran `sqlite3 app.db -header -column "SELECT * FROM customers;"` through dsh's `bash`
tool. The command ran on your machine against the real table, and veil pseudonymised the output
before it went back to DeepSeek:

```text
on your machine
id  name               email                  phone              plan
--  -----------------  ---------------------  -----------------  ----
1   Leonie Köhler      leonekohler@surfeu.de  +49 0711 2842222   pro
2   François Tremblay  ftremblay@gmail.com    +1 (514) 721-4711  free
3   Bjørn Hansen       bjorn.hansen@yahoo.no  +47 22 44 22 22    pro

what DeepSeek received
id  name               email                  phone              plan
--  -----------------  ---------------------  -----------------  ----
1   First_Jm9e Last_Jm9e      user_jm9e@example.test  +1-476-555-0107   pro
2   First_Qxni Last_Qxni  user_qxni@example.test    +1-686-555-0151  free
3   First_Xt7p Last_Xt7p       user_xt7p@example.test  +1-272-555-0115    pro
```

The session made 12 model requests, captured with veil's `--capture`. None of them contained any of
the table's real names, emails or phone numbers. The diagnosis came back with the real email in it.
The reasoning lines still show pseudonyms (see [Limits](#limits)).

## Install

1. Install veil 0.3.1 or later, then seed it with the data the model must not see:

   ```bash
   pip install veil-proxy             # or: brew install lemonadesaltbagel/veil/veil
   veil seed ./app.db                 # SQLite here; also Postgres, MySQL, MongoDB, files, … (see veil's README)
   ```

2. Add the plugin to a dsh profile (dsh 0.2.1-rc.2 or later; `dsh plugin` needs `pnpm`):

   ```bash
   dsh plugin --profile headless add dsh-veil
   dsh plugin --profile web add dsh-veil
   ```

   Or install a release tarball from GitHub:

   ```bash
   dsh plugin --profile headless add https://github.com/lemonadesaltbagel/dsh-veil/releases/download/v0.1.0/dsh-veil-0.1.0.tgz
   ```

3. Use dsh as usual. `dsh --profile headless "…"` and the web app start veil with the session and
   stop it on exit. `/veil` shows the proxy, the upstream and the counts of seeded values and
   pseudonyms.

## What it changes in your profile

The bundle's patch (`cordis.patch.yml`) does four things:

- **Starts veil.** The `veil` row runs `veil proxy` on a free loopback port. It provides the `veil`
  service only after the proxy answers its health check.
- **Routes DeepSeek through it.** The `llm-deepseek` and `llm-deepseek-account` rows inject that
  service and take `baseURL` from it.
- **Fails closed.** If veil can't start, those rows never activate. dsh then reports
  `NO_ADAPTER` and sends nothing, instead of calling DeepSeek directly.
- **Turns off `llm-pi-ai`.** That route sends other providers (OpenAI, Gemini, …) straight to
  their APIs, past veil.

A fetch guard backs this up. It refuses any model request (`/messages`, `/chat/completions`,
`/responses`, `:generateContent`) that isn't addressed to veil. It catches a later layer that points
an adapter elsewhere, such as a profile `cordis.patch.yml`, a `--patch` overlay or a Models setting,
and prints `dsh-veil: refused a model request to …`.

## Tool calls

veil restores real values into a tool call only for tools it knows by name. dsh's tools take Claude
Code's argument names, so the plugin maps them onto veil's roles (`veil proxy --tool-alias`):

| dsh tool | veil role | what the tool receives |
|---|---|---|
| `bash` | Bash | real values, shell-escaped; commands that send data off the machine keep pseudonyms |
| `read`, `grep`, `glob`, `working_directory` | Read / Grep / Glob | real values |
| `edit`, `write` | Edit / Write | real values only where the file already had them, escaped for the file's language |
| `str_replace_editor` | (built in) | as Write / Edit |
| every other tool (`run_code`, `workflow`, `pwsh`, `subagent`, `web_*`, terminals) | none | pseudonyms only |

## Configuration

Override the `veil` row in your profile's `cordis.patch.yml`:

```yaml
- id: veil
  config:
    command: /opt/homebrew/bin/veil                 # default: veil on PATH
    upstream: https://api.deepseek.com/anthropic    # default: $DEEPSEEK_BASE_URL, then this
    args: [--ner]                                   # extra `veil proxy` arguments
    # url: http://127.0.0.1:8787                    # use a running `veil proxy` instead of starting one
    # toolAliases: {bash: Bash}                     # replaces the table above
    # logFile: /tmp/veil.log                        # default: <tmp>/dsh-veil/veil-<pid>.log
    # startTimeoutMs: 60000
    # guardFetch: true
```

veil's own settings (vault, seeded sources, display mode) live in `VEIL_HOME`, shared with the
`veil` CLI. See the [veil README](https://github.com/lemonadesaltbagel/veil#readme).

## Limits

- **Reasoning stays pseudonymised.** dsh prints the model's reasoning (`dsh: reasoning:`) as
  DeepSeek wrote it, with pseudonyms. Answers and tool calls get real values back; reasoning blocks
  are passed through unchanged because they are sent back to the model on the next turn.
- **Your machine is trusted.** dsh's session logs hold real values, because veil hands dsh real
  values on the way back. Only the DeepSeek API sees pseudonyms.
- **Images aren't scanned.** veil passes images and `/v1/files` uploads through unchanged.
- **No other providers.** The DeepSeek account route signs in with an account token, which the
  account service may refuse to send to a local address; the API-key route is the tested one. The
  pi-ai providers are off.
- **Tested surface.** The end-to-end test covers `dsh --profile headless`. The web app uses the
  same rows, but `/veil` hasn't been exercised in its UI yet.
- **Leftover proxy.** veil stops with dsh. If dsh is killed with SIGKILL, its veil proxy keeps
  running until you stop it.

## Development

```bash
npm install && npm run build
npm test                 # unit tests
npm run e2e              # real dsh + real veil + a scripted model: 0 leaks, tools get real values,
                         # fails closed without veil, refuses a baseURL past veil
```

The e2e test needs `dsh`, `pnpm` and `veil` on PATH, or `DSH_BIN` and `VEIL_BIN`. CI runs it on
every push against the npm `dsh` and the PyPI `veil-proxy`.

## License

Apache License 2.0, like veil.
