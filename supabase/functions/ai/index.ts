// NutriLog — Edge Function "ai"
// Ο μοναδικός τόπος όπου χρησιμοποιείται το Gemini API key. Η εφαρμογή δεν το βλέπει ποτέ:
// στέλνει εδώ το αίτημα μαζί με το token του συνδεδεμένου χρήστη, και η function
//   1. ελέγχει ότι ο χρήστης είναι συνδεδεμένος,
//   2. μετρά το ημερήσιο όριο αιτημάτων του (εκτός αν είναι στο public.ai_unlimited),
//   3. καλεί το Gemini με το κρυφό κλειδί (secret GEMINI_API_KEY).
//
// Ενέργειες: models, analyze (φωτογραφία/περιγραφή), chat (βοηθός, μπορεί να προτείνει καταγραφή),
//            suggest (προτάσεις γευμάτων), review (εβδομαδιαία ανασκόπηση).
//
// Secrets (Supabase → Edge Functions → Secrets):
//   GEMINI_API_KEY   (υποχρεωτικό) το κλειδί από το Google AI Studio
//   AI_DAILY_LIMIT   (προαιρετικό) αιτήματα AI ανά χρήστη την ημέρα, προεπιλογή 60

import { createClient } from 'npm:@supabase/supabase-js@2';

const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const DAILY_LIMIT = Number(Deno.env.get('AI_DAILY_LIMIT') ?? '60');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
const GAPI = 'https://generativelanguage.googleapis.com/v1beta';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/* ---------- Μοντέλα ---------- */
// Κρατάμε τη λίστα για 6 ώρες. Όταν η Google αποσύρει ένα μοντέλο, η λίστα ανανεώνεται
// και η αυτόματη επιλογή περνά στο νεότερο διαθέσιμο Flash.
let modelCache: { at: number; ids: string[] } | null = null;
async function listModels(force = false): Promise<string[]> {
  if (!force && modelCache && Date.now() - modelCache.at < 6 * 3600e3) return modelCache.ids;
  const r = await fetch(`${GAPI}/models?pageSize=1000`, { headers: { 'x-goog-api-key': GEMINI_KEY } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, `Σφάλμα AI: ${j?.error?.message ?? `HTTP ${r.status}`}`);
  const bad = /(image|tts|audio|live|embed|exp|thinking|robotics|computer|customtools|native)/;
  const ids = ((j.models ?? []) as { name: string; supportedGenerationMethods?: string[] }[])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini-\d/.test(n) && /(flash|pro)/.test(n) && !bad.test(n));
  modelCache = { at: Date.now(), ids };
  return ids;
}
const ver = (n: string) => parseFloat(n.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] ?? '0');
const sortModels = (ids: string[]) =>
  [...ids].sort((a, b) => ver(b) - ver(a) || Number(/preview/.test(a)) - Number(/preview/.test(b)) || a.length - b.length);
function autoPick(ids: string[]): string {
  const flash = sortModels(ids.filter((n) => n.includes('flash') && !n.includes('lite')));
  return flash[0] ?? sortModels(ids)[0] ?? 'gemini-flash-latest';
}
function publicList(ids: string[]): string[] {
  const stable = ids.filter((n) => !/preview/.test(n) && !/-\d{3}$/.test(n));
  return sortModels(stable.length ? stable : ids).slice(0, 8);
}
const isGone = (status: number, msg = '') =>
  status === 404 || /no longer available|not found|not supported|deprecated|update your code/i.test(msg);

type Part = { text?: string; thought?: boolean; functionCall?: { name: string; args: Record<string, unknown> } };

async function generateRaw(requested: string, payload: unknown): Promise<{ parts: Part[]; model: string; finish?: string; block?: string }> {
  const ids = await listModels();
  let model = requested && ids.includes(requested) ? requested : autoPick(ids);
  const post = async (m: string) => {
    const r = await fetch(`${GAPI}/models/${encodeURIComponent(m)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data, msg: data?.error?.message as string | undefined };
  };
  let res = await post(model);
  if (!res.ok && isGone(res.status, res.msg)) {
    const next = autoPick(await listModels(true));
    if (next !== model) { model = next; res = await post(model); }
  }
  if (!res.ok) {
    if (res.status === 429) throw new HttpError(429, 'Το AI είναι προσωρινά πολύ απασχολημένο. Δοκίμασε ξανά σε ένα λεπτό.');
    throw new HttpError(502, `Σφάλμα AI: ${res.msg ?? `HTTP ${res.status}`}`);
  }
  const cand = res.data?.candidates?.[0];
  return { parts: (cand?.content?.parts ?? []) as Part[], model, finish: cand?.finishReason, block: res.data?.promptFeedback?.blockReason };
}
const textOf = (parts: Part[]) => parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');

async function generateJson(requested: string, prompt: string, schema: unknown, image?: string, temperature = 0.3) {
  const parts: unknown[] = [{ text: prompt }];
  if (image) parts.push({ inlineData: { mimeType: 'image/jpeg', data: image } });
  const r = await generateRaw(requested, {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: schema },
  });
  const text = textOf(r.parts);
  if (!text) throw new HttpError(502, `Το AI δεν έδωσε απάντηση (${r.block ?? r.finish ?? 'άγνωστο'}). Δοκίμασε ξανά.`);
  try {
    return { result: JSON.parse(text.replace(/^\s*```(?:json)?/, '').replace(/```\s*$/, '')), model: r.model };
  } catch {
    throw new HttpError(502, 'Το AI επέστρεψε μη έγκυρη απάντηση. Δοκίμασε ξανά.');
  }
}

/* ---------- Βοηθητικά ---------- */
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const str = (v: unknown, max: number) => String(v ?? '').slice(0, max);
const MEAL_NAMES: Record<string, string> = { breakfast: 'Πρωινό', lunch: 'Μεσημεριανό', dinner: 'Βραδινό', snack: 'Σνακ' };
function contextText(c: Record<string, any> = {}) {
  const g = c.goals ?? {}, t = c.today ?? {};
  const goalName: Record<string, string> = { lose: 'απώλεια βάρους', lose_slow: 'ήπια απώλεια βάρους', maintain: 'διατήρηση βάρους', gain: 'αύξηση μυϊκής μάζας' };
  const items = (Array.isArray(c.todayItems) ? c.todayItems : []).slice(0, 30)
    .map((i: any) => `${MEAL_NAMES[i.meal] ?? i.meal}: ${str(i.name, 60)}${i.grams ? ` ${num(i.grams)}g` : ''} (${num(i.kcal)} kcal)`).join('; ');
  const favs = (Array.isArray(c.favorites) ? c.favorites : []).slice(0, 20).map((f: unknown) => str(f, 50)).join(', ');
  return `Χρήστης: ${str(c.name, 40) || 'χωρίς όνομα'} · στόχος: ${goalName[c.goal] ?? 'διατήρηση βάρους'}.
Ημερήσιοι στόχοι: ${num(g.kcal)} kcal, πρωτεΐνη ${num(g.protein)}g, υδατάνθρακες ${num(g.carbs)}g, λιπαρά ${num(g.fat)}g, ίνες ${num(g.fiber)}g, νερό ${num(g.water)}ml.
Μέχρι τώρα σήμερα: ${num(t.kcal)} kcal, πρωτεΐνη ${num(t.protein)}g, υδατάνθρακες ${num(t.carbs)}g, λιπαρά ${num(t.fat)}g, ίνες ${num(t.fiber)}g, νερό ${num(t.water)}ml.
Σημερινές καταχωρήσεις: ${items || 'καμία'}.
Τρόφιμα που τρώει συχνά: ${favs || '—'}.
Streak: ${num(c.streak)} μέρες (καλύτερο ${num(c.bestStreak)}). Ανοχή streak: ±${num(c.tolerance) || 10}%${c.requireProtein ? ', απαιτείται και πρωτεΐνη ≥90%' : ''}.
Τοπική ώρα χρήστη: ${str(c.localTime, 20) || 'άγνωστη'}.`;
}

/* ---------- Σχήματα ---------- */
const ITEM_PROPS = {
  name: { type: 'STRING' }, grams: { type: 'NUMBER' }, kcal: { type: 'NUMBER' }, protein: { type: 'NUMBER' },
  carbs: { type: 'NUMBER' }, fat: { type: 'NUMBER' }, fiber: { type: 'NUMBER' }, sugar: { type: 'NUMBER' },
  sodium: { type: 'NUMBER', description: 'νάτριο σε mg' }, satfat: { type: 'NUMBER', description: 'κορεσμένα λιπαρά σε g' },
  calcium: { type: 'NUMBER', description: 'ασβέστιο σε mg' }, iron: { type: 'NUMBER', description: 'σίδηρος σε mg' },
  potassium: { type: 'NUMBER', description: 'κάλιο σε mg' }, vitc: { type: 'NUMBER', description: 'βιταμίνη C σε mg' },
};
const ITEM_REQ = ['name', 'grams', 'kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium', 'satfat', 'calcium', 'iron', 'potassium', 'vitc'];
const ITEM = { type: 'OBJECT', properties: ITEM_PROPS, required: ITEM_REQ };
const ITEM_RULES = `Για κάθε στοιχείο δώσε τιμές για ΟΛΗ την ποσότητα (όχι ανά 100g): kcal, πρωτεΐνη, υδατάνθρακες, λιπαρά, φυτικές ίνες, σάκχαρα (g), νάτριο (mg), κορεσμένα λιπαρά (g), ασβέστιο (mg), σίδηρο (mg), κάλιο (mg), βιταμίνη C (mg). Ονόματα στα ελληνικά.`;

const MEAL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_food: { type: 'BOOLEAN' },
    dish: { type: 'STRING' },
    items: { type: 'ARRAY', items: ITEM },
    confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
    notes: { type: 'STRING' },
  },
  required: ['is_food', 'dish', 'items', 'confidence', 'notes'],
};

/* ---------- Ανάλυση γεύματος ---------- */
async function analyze(body: Record<string, any>) {
  const image = typeof body.image === 'string' ? body.image : '';
  const desc = str(body.desc, 600).trim();
  if (!image && !desc) throw new HttpError(400, 'Στείλε φωτογραφία ή περιγραφή του γεύματος.');
  if (image.length > 4_000_000) throw new HttpError(413, 'Η φωτογραφία είναι πολύ μεγάλη.');
  const prompt = `Είσαι έμπειρος διαιτολόγος. Ανάλυσε το γεύμα${image ? ' της φωτογραφίας' : ' που περιγράφει ο χρήστης'}.
- Αναγνώρισε κάθε τρόφιμο/συστατικό ξεχωριστά και εκτίμησε την ποσότητα σε γραμμάρια (χρησιμοποίησε πιάτο, μαχαιροπίρουνα κ.λπ. ως μέτρο σύγκρισης).
- ${ITEM_RULES}
- Αν είναι πιθανό να υπάρχει λάδι μαγειρέματος ή σάλτσα, πρόσθεσέ τα ως ξεχωριστό στοιχείο.
- Στο "dish" δώσε σύντομο όνομα για όλο το γεύμα.
- Στο "notes" γράψε 2-3 σύντομες προτάσεις στα ελληνικά: διατροφική αξιολόγηση και πώς ταιριάζει με τους στόχους του χρήστη.
- Αν δεν πρόκειται για φαγητό/ποτό, βάλε is_food=false και κενή λίστα items.
${contextText(body.context)}${desc ? `\nΣημειώσεις/περιγραφή από τον χρήστη: ${desc}` : ''}`;
  return generateJson(str(body.model, 80), prompt, MEAL_SCHEMA, image, 0.2);
}

/* ---------- Προτάσεις γευμάτων ---------- */
const SUGGEST_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intro: { type: 'STRING' },
    suggestions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { title: { type: 'STRING' }, why: { type: 'STRING' }, items: { type: 'ARRAY', items: ITEM } },
        required: ['title', 'why', 'items'],
      },
    },
  },
  required: ['intro', 'suggestions'],
};
async function suggest(body: Record<string, any>) {
  const meal = MEAL_NAMES[body.meal] ? body.meal : 'snack';
  const prompt = `Είσαι διαιτολόγος. Πρότεινε 3 διαφορετικές, ρεαλιστικές επιλογές για ${MEAL_NAMES[meal]} που ταιριάζουν στα υπόλοιπα της ημέρας του χρήστη.
- Λάβε υπόψη πόσες θερμίδες και μακροθρεπτικά του μένουν για σήμερα και τι έχει ήδη φάει. Αν μένει πρωτεΐνη, δώσε προτεραιότητα σε αυτή.
- Χρησιμοποίησε τρόφιμα που βρίσκει κανείς εύκολα σε ελληνικό σούπερ μάρκετ, και προτίμησε όσα τρώει συχνά ο χρήστης όταν ταιριάζουν.
- Απλές συνταγές (έως 15 λεπτά) ή έτοιμες επιλογές. Ποικιλία: τουλάχιστον μία πολύ εύκολη επιλογή.
- "title": σύντομο όνομα. "why": μία πρόταση γιατί ταιριάζει (π.χ. «καλύπτει 35g από την πρωτεΐνη που σου λείπει»). "intro": μία πρόταση με το τι του μένει.
- ${ITEM_RULES}
${str(body.wish, 200) ? `Επιθυμία χρήστη: ${str(body.wish, 200)}\n` : ''}${contextText(body.context)}`;
  return generateJson(str(body.model, 80), prompt, SUGGEST_SCHEMA, undefined, 0.8);
}

/* ---------- Εβδομαδιαία ανασκόπηση ---------- */
const REVIEW_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING' },
    score: { type: 'NUMBER', description: '0-100 βαθμός συνέπειας της εβδομάδας' },
    summary: { type: 'STRING' },
    wins: { type: 'ARRAY', items: { type: 'STRING' } },
    improve: { type: 'ARRAY', items: { type: 'STRING' } },
    next_goal: { type: 'STRING' },
  },
  required: ['headline', 'score', 'summary', 'wins', 'improve', 'next_goal'],
};
async function review(body: Record<string, any>) {
  const days = (Array.isArray(body.week) ? body.week : []).slice(0, 7).map((d: any) =>
    `${str(d.date, 10)} (${str(d.weekday, 12)}): ${d.status === 'none' ? 'χωρίς καταγραφή' : `${num(d.kcal)} kcal, Π ${num(d.protein)}g, Υ ${num(d.carbs)}g, Λ ${num(d.fat)}g, ίνες ${num(d.fiber)}g, σάκχαρα ${num(d.sugar)}g, νερό ${num(d.water)}ml, ${num(d.entries)} καταχωρήσεις, ${d.status === 'hit' ? 'εντός στόχου' : d.status === 'freeze' ? 'πάγωμα streak' : 'εκτός στόχου'}`}${d.weight ? `, βάρος ${Number(d.weight)}kg` : ''}`).join('\n');
  if (!days) throw new HttpError(400, 'Δεν υπάρχουν δεδομένα για αυτή την εβδομάδα.');
  const prompt = `Είσαι υποστηρικτικός διαιτολόγος-coach. Γράψε την εβδομαδιαία ανασκόπηση του χρήστη στα ελληνικά, σε β' ενικό, θετικά αλλά ειλικρινά.
- "headline": μία φράση-τίτλος (με ένα emoji).
- "score": 0-100 με βάση τη συνέπεια (μέρες εντός στόχου, μέρες καταγραφής, πρωτεΐνη, νερό).
- "summary": 2-3 προτάσεις με τα σημαντικότερα, με συγκεκριμένους αριθμούς.
- "wins": 2-3 συγκεκριμένα πράγματα που πήγαν καλά.
- "improve": 2-3 συγκεκριμένα, πρακτικά σημεία βελτίωσης (π.χ. «τα Σαββατοκύριακα ξεπερνάς κατά ~400 kcal»).
- "next_goal": ένας μικρός, μετρήσιμος στόχος για την επόμενη εβδομάδα.
Αν υπάρχουν λίγες καταγραφές, ενθάρρυνε την καταγραφή χωρίς να κατηγορείς.

Ημερήσιες τιμές της εβδομάδας:
${days}

${contextText(body.context)}`;
  return generateJson(str(body.model, 80), prompt, REVIEW_SCHEMA, undefined, 0.5);
}

/* ---------- Βοηθός Nutri ---------- */
const APP_GUIDE = `Είσαι ο «Nutri», ο φιλικός βοηθός της εφαρμογής NutriLog (καταγραφή θερμίδων και διατροφής).
Μιλάς ΠΑΝΤΑ ελληνικά, σύντομα, ζεστά και πρακτικά. Χρησιμοποίησε λίστες όταν εξηγείς βήματα και **έντονα** για ονόματα κουμπιών/καρτελών. Λίγα emoji είναι εντάξει.
Βοηθάς σε τρία πράγματα: (α) πώς λειτουργεί η εφαρμογή, (β) ερωτήσεις διατροφής με βάση τους στόχους του χρήστη, (γ) καταγραφή φαγητού από τη συζήτηση.
Μην επινοείς λειτουργίες που δεν υπάρχουν παρακάτω. Αν κάτι δεν υπάρχει, πες το ευγενικά.
Δεν κάνεις ιατρικές διαγνώσεις· για παθήσεις, εγκυμοσύνη, διατροφικές διαταραχές ή φάρμακα πρότεινε γιατρό ή διαιτολόγο. Μην προτείνεις ποτέ κάτω από 1200 kcal/ημέρα.
Αν ο χρήστης ζητήσει κάτι άσχετο με την εφαρμογή, τη διατροφή ή την υγιεινή ζωή, επανέφερε ευγενικά τη συζήτηση.

ΚΑΤΑΓΡΑΦΗ ΑΠΟ ΤΗ ΣΥΖΗΤΗΣΗ
Όταν ο χρήστης λέει ότι έφαγε/ήπιε κάτι ή ζητά να καταγραφεί κάτι, κάλεσε το εργαλείο log_food με εκτιμήσεις για όλη την ποσότητα.
Διάλεξε γεύμα από την ώρα ή τα λόγια του (πρωί→breakfast, μεσημέρι→lunch, βράδυ→dinner, αλλιώς snack). Η εφαρμογή θα του δείξει κάρτα για επιβεβαίωση, οπότε στο κείμενό σου απλώς σχολίασε σύντομα (π.χ. «Ωραίο πρωινό με καλή πρωτεΐνη! Πάτα Προσθήκη για να μπει στο ημερολόγιο.»).
Αν η ποσότητα είναι εντελώς ασαφής, κάνε λογική εκτίμηση τυπικής μερίδας και ανέφερέ την.

ΟΔΗΓΟΣ ΕΦΑΡΜΟΓΗΣ
Κάτω μπάρα με 4 καρτέλες: Σήμερα, Πρόοδος, Σάρωση, Προφίλ. Το πράσινο κουμπί «✨ Βοηθός» κάτω δεξιά ανοίγει εσένα.

1) Σήμερα
- Ο κύκλος δείχνει θερμίδες σε σχέση με τον στόχο, το «Υπόλοιπο» (ή «Υπέρβαση») και το «Εύρος στόχου».
- Μπάρες για πρωτεΐνη, υδατάνθρακες, λιπαρά, φυτικές ίνες και σάκχαρα (τα σάκχαρα είναι ανώτατο όριο).
- «Μικροθρεπτικά» (αναδιπλούμενη κάρτα): νάτριο, κορεσμένα λιπαρά, ασβέστιο, σίδηρος, κάλιο, βιταμίνη C σε σχέση με τις συνιστώμενες ποσότητες. Υπολογίζονται μόνο για τρόφιμα που έχουν τέτοια στοιχεία.
- «💡 Τι να φάω;»: 3 προτάσεις από το AI που ταιριάζουν σε ό,τι σου μένει, με κουμπί «Προσθήκη».
- Νερό: − / + ανά 250 ml. Βάρος: προαιρετικό, εμφανίζεται σε γράφημα στην Πρόοδο.
- Γεύματα: Πρωινό, Μεσημεριανό, Βραδινό, Σνακ. Σε άδειο γεύμα εμφανίζεται «↺ Ίδιο με χθες» αν χθες είχες καταγράψει κάτι σε αυτό. Σε γεμάτο γεύμα το «⭐ Αποθήκευση» το κρατά ως αγαπημένο γεύμα.
- Το «+ Προσθήκη τροφίμου» έχει 4 καρτέλες:
  • Αναζήτηση: ~110 τρόφιμα (πολλά ελληνικά), «Πρόσφατα», και κουμπί «🔎 Ψάξε σε προϊόντα σούπερ μάρκετ» που ψάχνει σε εκατομμύρια προϊόντα (Open Food Facts). Κουμπί «📷 Barcode» για σάρωση του barcode μιας συσκευασίας.
  • Γεύματα: τα αποθηκευμένα αγαπημένα γεύματα — ένα πάτημα και μπαίνουν όλα.
  • Γρήγορη: απευθείας θερμίδες και μακροθρεπτικά.
  • Νέο τρόφιμο: δικό σου τρόφιμο με τιμές ανά 100 g (εμφανίζεται με ⭐).
- Διαγραφή με ×. Τα βελάκια ‹ › αλλάζουν μέρα.

2) Πρόοδος
- Κάρτες: τρέχον streak 🔥, καλύτερο 🏆, μέρες επιτυχίας ✅, μέρες καταγραφής 📒.
- «Επιτεύγματα»: παράσημα (π.χ. 7 και 30 μέρες streak, 100 καταγραφές, πρώτη σάρωση, πρώτο barcode). Ξεκλειδώνονται αυτόματα με γιορτή 🎉.
- Ημέρα / Εβδομάδα / Μήνας / Έτος. Στον Μήνα, ημερολόγιο: πράσινο = εντός στόχου, πορτοκαλί = εκτός, μπλε = πάγωμα streak, γκρι = χωρίς καταγραφή.
- Στην Εβδομάδα: «🧠 Ανασκόπηση εβδομάδας» από τον Nutri με βαθμό, τι πήγε καλά, τι να βελτιώσεις και στόχο για την επόμενη εβδομάδα.

3) Streak & πάγωμα
- Μέρα επιτυχίας: θερμίδες μέσα στο ± της ανοχής (προεπιλογή ±10%), προαιρετικά και πρωτεΐνη ≥ 90%.
- Το streak μετρά συνεχόμενες μέρες επιτυχίας. Η σημερινή μετράει μόλις μπεις στο εύρος· μέχρι να τελειώσει η μέρα δεν χάνεται.
- «❄️ Πάγωμα streak»: 1 τον μήνα. Σώζει το streak για μια μέρα που χάθηκε (δεν προσθέτει μέρα). Εμφανίζεται στο Σήμερα όταν χθες χάθηκε, ή από την Πρόοδο → Ημέρα.
- Κανόνες: Προφίλ → «Κανόνες streak».

4) Σάρωση (AI)
- Φωτογραφία (📷 Κάμερα/συλλογή) ή μόνο περιγραφή → «✨ Ανάλυση γεύματος» → διόρθωση γραμμαρίων, επιλογή γεύματος, «Προσθήκη σήμερα». Οι εκτιμήσεις είναι προσεγγιστικές (±20–30%).
- Υπάρχει ημερήσιο όριο ${DAILY_LIMIT} αιτημάτων AI ανά χρήστη (σαρώσεις, μηνύματα, προτάσεις, ανασκοπήσεις).

5) Προφίλ
- Λογαριασμός και «Αποσύνδεση». «Οι στόχοι σου» με «🧮 Επανυπολογισμός» (Mifflin-St Jeor × δραστηριότητα, −500/−250/0/+300 kcal ανάλογα τον στόχο· πρωτεΐνη 1,6–2,0 g/kg, λιπαρά ~27%, ίνες 14 g/1000 kcal, νερό 35 ml/kg) και χειροκίνητη ρύθμιση.
- «🔔 Υπενθυμίσεις»: ειδοποιήσεις για πρωινό/μεσημεριανό/βραδινό (στην ώρα που ορίζεις, μόνο αν δεν έχεις καταγράψει), νερό στις 16:00 αν έχεις πιει λιγότερο από τα μισά, «το streak κινδυνεύει» το βράδυ, και εβδομαδιαία ανασκόπηση Κυριακή 19:00. Στο iPhone πρέπει πρώτα να εγκαταστήσεις την εφαρμογή στην οθόνη Αφετηρίας (iOS 16.4+).
- «Κανόνες streak», «Nutri AI» (μοντέλο: Αυτόματο/Flash/Flash-Lite/Pro), «Εμφάνιση», «Τα τρόφιμα & γεύματά μου», «Δεδομένα» (εξαγωγή/εισαγωγή), «Διαγραφή λογαριασμού» (οριστική, σβήνει όλα τα δεδομένα), σύνδεσμοι σε Πολιτική Απορρήτου και Όρους Χρήσης.

6) Λογαριασμός & απόρρητο
- Τα δεδομένα αποθηκεύονται στον λογαριασμό του χρήστη (servers στην ΕΕ) και είναι ίδια σε όλες τις συσκευές. Τα βλέπει μόνο ο ίδιος. Λειτουργεί και offline.
- Φωτογραφίες και ερωτήσεις προς το AI στέλνονται στο Google Gemini για επεξεργασία. Barcode και αναζητήσεις προϊόντων στο Open Food Facts.

7) Εγκατάσταση στο κινητό: Android (Chrome) μενού ⋮ → «Εγκατάσταση εφαρμογής». iPhone (Safari) Κοινοποίηση → «Προσθήκη στην οθόνη Αφετηρίας».`;

const TOOLS = [{
  functionDeclarations: [{
    name: 'log_food',
    description: 'Προτείνει καταγραφή φαγητών/ποτών στο ημερολόγιο του χρήστη. Χρησιμοποίησέ το ΜΟΝΟ όταν ο χρήστης λέει ότι έφαγε/ήπιε κάτι ή ζητά να καταγραφεί κάτι. Ο χρήστης θα επιβεβαιώσει πριν μπει.',
    parameters: {
      type: 'OBJECT',
      properties: {
        meal: { type: 'STRING', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
        day: { type: 'STRING', enum: ['today', 'yesterday'], description: 'σήμερα εκτός αν ο χρήστης πει «χθες»' },
        items: { type: 'ARRAY', items: ITEM },
      },
      required: ['meal', 'day', 'items'],
    },
  }],
}];

async function chat(body: Record<string, any>) {
  const msgs = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m: any) => m && (m.role === 'user' || m.role === 'model') && typeof m.text === 'string')
    .slice(-16)
    .map((m: any) => ({ role: m.role, parts: [{ text: str(m.text, 2000) }] }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length) throw new HttpError(400, 'Κενό μήνυμα.');
  const tabName: Record<string, string> = { today: 'Σήμερα', progress: 'Πρόοδος', ai: 'Σάρωση', settings: 'Προφίλ' };
  const system = `${APP_GUIDE}\n\nΤΡΕΧΟΥΣΑ ΚΑΤΑΣΤΑΣΗ ΧΡΗΣΤΗ\n${contextText(body.context)}\nΑνοιχτή καρτέλα: ${tabName[body.context?.tab] ?? 'Σήμερα'}.`;
  const r = await generateRaw(str(body.model, 80), {
    systemInstruction: { parts: [{ text: system }] },
    contents: msgs,
    tools: TOOLS,
    generationConfig: { temperature: 0.6 },
  });
  const actions = r.parts.filter((p) => p.functionCall?.name === 'log_food').map((p) => {
    const a = p.functionCall!.args as Record<string, any>;
    return { type: 'log_food', meal: MEAL_NAMES[a.meal] ? a.meal : 'snack', day: a.day === 'yesterday' ? 'yesterday' : 'today', items: Array.isArray(a.items) ? a.items.slice(0, 20) : [] };
  }).filter((a) => a.items.length);
  let text = textOf(r.parts);
  if (!text && actions.length) text = 'Ορίστε τι κατάλαβα — έλεγξέ το και πάτα **Προσθήκη** για να μπει στο ημερολόγιο.';
  if (!text) throw new HttpError(502, `Το AI δεν έδωσε απάντηση (${r.block ?? r.finish ?? 'άγνωστο'}). Δοκίμασε ξανά.`);
  return { text, actions, model: r.model };
}

/* ---------- Είσοδος ---------- */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const auth = req.headers.get('Authorization') ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token) return json(401, { error: 'Πρέπει να συνδεθείς.' });
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await sb.auth.getUser(token);
    if (!user) return json(401, { error: 'Η σύνδεσή σου έληξε. Συνδέσου ξανά.' });
    if (!GEMINI_KEY) return json(500, { error: 'Το AI δεν έχει ρυθμιστεί ακόμα (λείπει το GEMINI_API_KEY).' });

    const body = await req.json().catch(() => ({}));
    if (body.action === 'models') {
      const ids = await listModels();
      return json(200, { models: publicList(ids), auto: autoPick(ids) });
    }
    const handlers: Record<string, (b: Record<string, any>) => Promise<unknown>> = { analyze, chat, suggest, review };
    const handler = handlers[body.action];
    if (!handler) return json(400, { error: 'Άγνωστη ενέργεια.' });

    const { data: used, error } = await sb.rpc('bump_ai_usage', { p_limit: DAILY_LIMIT });
    if (error) console.error('bump_ai_usage', error);
    if (used === -1) return json(429, { error: `Έφτασες το ημερήσιο όριο των ${DAILY_LIMIT} αιτημάτων AI. Δοκίμασε ξανά αύριο.` });

    return json(200, await handler(body));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error(e);
    return json(status, { error: e instanceof Error ? e.message : 'Σφάλμα server' });
  }
});
