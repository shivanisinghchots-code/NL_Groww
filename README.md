# SIP Drop-off Discovery Engine (Vercel deploy)

Two pages on one Vercel project, sharing one Groq key that stays on the server:
- `/` : the SIP Discovery engine (`index.html` + `api/ai.js`)
- `/assistant` : the **Break Assistant MVP** (`assistant.html` + `api/break.js`)

## Deploy (about 5 minutes)

### Option A: Vercel website + GitHub
1. Create a new GitHub repository and upload everything in this folder.
2. On vercel.com: **Add New → Project → Import** that repository. Framework preset: **Other**. No build command.
3. Before deploying, open **Environment Variables** and add:
   - `GROQ_API_KEY` = your Groq key (create a fresh one at console.groq.com → API Keys)
4. Click **Deploy**. Open the URL and check the badge in the top bar says **Live AI on**, on both `/` and `/assistant`.

Updating an existing deploy: replace the files in the GitHub repo with this folder's contents and commit;
Vercel redeploys on its own. The key you already set is reused.

### Option B: Vercel CLI from your Mac
```bash
npm install -g vercel
cd sip-discovery-vercel
vercel                      # first run: log in, accept defaults
vercel env add GROQ_API_KEY # paste the key when asked; choose Production (and Preview)
vercel --prod
```

## Optional settings (environment variables)
| Variable | Default | What it does |
|---|---|---|
| `GROQ_MODELS` | `openai/gpt-oss-120b,openai/gpt-oss-20b` | Models tried in order; the next is used when one hits its daily limit |
| `RATE_LIMIT_PER_10_MIN` | `20` | Requests allowed per visitor per 10 minutes |

## How the live AI works
- The page sends only task inputs: the pasted post for **Test**, or the question plus the ids of
  posts it retrieved for **Ask**. Prompts are built on the server from `lib/prompts.js`, and Ask can
  only use posts that exist in `data.json`, so the endpoint can't be used as a general chatbot.
- Inputs are capped (3,000 characters for a post, 300 for a question, 30 posts).
- The page runs the same checks as before: codebook values, quote grounding, the stop verifier,
  citation checks and number checks.
- Opened inside claude.ai, the same page uses the viewer's own Claude account instead.

## Break Assistant MVP (`/assistant`)
When a first-time investor taps Skip, Change or Cancel on a SIP, it asks why, in their own words, then shows options
that keep the SIP alive, each with the Groww Help Centre rule behind it.
- **The AI only reads and replies.** It works out the intent, the break length, the language (English, Hindi or
  Hinglish) and any hardship, and writes a reply of 45 words or fewer. Every option, date and consequence comes from code (`lib/break.js`)
  built on 13 rules quoted from the Groww Help Centre.
- **The gate checks every reply** (format, no advice, no fear or urgency, no numbers, no claims about what you can do,
  real citations, right language, advice requests declined). If any check fails, a safe default reply is shown instead, and
  the page shows which check failed.
- **Fallbacks:** if the AI is down, slow (over 25 seconds) or rate-limited, a rule-only reading is used and the page says so.
  The options and the original action are always shown.
- **Evals** (in `evals/`): 32 golden cases, 12 held-out phrasings, and 62 deterministic gate, privacy and language tests.
  The results are shown on the page under Quality.

## Usage limits
Groq's free plan allows about 200,000 tokens per model per day. A Test run uses roughly 3,000–6,000
tokens and an Ask about 6,000–9,000, so expect about 30–50 live requests a day across the two models.
If mentors hit the limit, the page says so and the rest of the site keeps working. For more, upgrade
the Groq plan.

## Files
- `index.html`: the discovery engine (data and prompts inlined)
- `assistant.html`: the Break Assistant (rules, planner, gate and eval results inlined)
- `api/break.js`, `lib/break.js`: the Break Assistant function and its shared rules, planner and gate
- `evals/`: golden and held-out sets, reports, gate tests
- `api/ai.js`: the discovery engine function (Test and Ask)
- `lib/prompts.js`: prompt builders shared by the page and the function
- `data.json`: coded evidence used by the function
- `vercel.json`: function timeout and bundled files
