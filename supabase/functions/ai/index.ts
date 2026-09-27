// NutriLog — Edge Function "ai"
// Ο μοναδικός τόπος όπου χρησιμοποιείται το Gemini API key. Η εφαρμογή δεν το βλέπει ποτέ:
// στέλνει εδώ το αίτημα μαζί με το token του συνδεδεμένου χρήστη, και η function
//   1. ελέγχει ότι ο χρήστης είναι συνδεδεμένος,
//   2. μετρά το ημερήσιο όριο αιτημάτων του,
//   3. καλεί το Gemini με το κρυφό κλειδί (secret GEMINI_API_KEY).
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

async function generate(requested: string, payload: unknown) {
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
  const text = ((cand?.content?.parts ?? []) as { text?: string; thought?: boolean }[])
    .filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  if (!text) {
    const why = res.data?.promptFeedback?.blockReason ?? cand?.finishReason ?? 'άγνωστο';
    throw new HttpError(502, `Το AI δεν έδωσε απάντηση (${why}). Δοκίμασε ξανά.`);
  }
  return { text, model };
}

/* ---------- Βοηθητικά ---------- */
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const str = (v: unknown, max: number) => String(v ?? '').slice(0, max);
function contextText(c: Record<string, any> = {}) {
  const g = c.goals ?? {}, t = c.today ?? {};
  const goalName: Record<string, string> = { lose: 'απώλεια βάρους', lose_slow: 'ήπια απώλεια βάρους', maintain: 'διατήρηση βάρους', gain: 'αύξηση μυϊκής μάζας' };
  return `Χρήστης: ${str(c.name, 40) || 'χωρίς όνομα'} · στόχος: ${goalName[c.goal] ?? 'διατήρηση βάρους'}.
Ημερήσιοι στόχοι: ${num(g.kcal)} kcal, πρωτεΐνη ${num(g.protein)}g, υδατάνθρακες ${num(g.carbs)}g, λιπαρά ${num(g.fat)}g, ίνες ${num(g.fiber)}g, νερό ${num(g.water)}ml.
Μέχρι τώρα σήμερα: ${num(t.kcal)} kcal, πρωτεΐνη ${num(t.protein)}g, υδατάνθρακες ${num(t.carbs)}g, λιπαρά ${num(t.fat)}g, ίνες ${num(t.fiber)}g, νερό ${num(t.water)}ml.
Streak: ${num(c.streak)} μέρες (καλύτερο ${num(c.bestStreak)}). Ανοχή streak: ±${num(c.tolerance) || 10}%${c.requireProtein ? ', απαιτείται και πρωτεΐνη ≥90%' : ''}.`;
}

/* ---------- Ανάλυση γεύματος ---------- */
const MEAL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_food: { type: 'BOOLEAN' },
    dish: { type: 'STRING' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' }, grams: { type: 'NUMBER' }, kcal: { type: 'NUMBER' }, protein: { type: 'NUMBER' },
          carbs: { type: 'NUMBER' }, fat: { type: 'NUMBER' }, fiber: { type: 'NUMBER' }, sugar: { type: 'NUMBER' },
        },
        required: ['name', 'grams', 'kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar'],
      },
    },
    confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
    notes: { type: 'STRING' },
  },
  required: ['is_food', 'dish', 'items', 'confidence', 'notes'],
};

async function analyze(body: Record<string, any>) {
  const image = typeof body.image === 'string' ? body.image : '';
  const desc = str(body.desc, 600).trim();
  if (!image && !desc) throw new HttpError(400, 'Στείλε φωτογραφία ή περιγραφή του γεύματος.');
  if (image.length > 4_000_000) throw new HttpError(413, 'Η φωτογραφία είναι πολύ μεγάλη.');
  const prompt = `Είσαι έμπειρος διαιτολόγος. Ανάλυσε το γεύμα${image ? ' της φωτογραφίας' : ' που περιγράφει ο χρήστης'}.
- Αναγνώρισε κάθε τρόφιμο/συστατικό ξεχωριστά και εκτίμησε την ποσότητα σε γραμμάρια (χρησιμοποίησε πιάτο, μαχαιροπίρουνα κ.λπ. ως μέτρο σύγκρισης).
- Για κάθε στοιχείο δώσε kcal, πρωτεΐνη, υδατάνθρακες, λιπαρά, φυτικές ίνες και σάκχαρα (g) για ΟΛΗ την εκτιμώμενη ποσότητα, όχι ανά 100g.
- Αν είναι πιθανό να υπάρχει λάδι μαγειρέματος ή σάλτσα, πρόσθεσέ τα ως ξεχωριστό στοιχείο.
- Ονόματα στα ελληνικά. Στο "dish" δώσε σύντομο όνομα για όλο το γεύμα.
- Στο "notes" γράψε 2-3 σύντομες προτάσεις στα ελληνικά: διατροφική αξιολόγηση και πώς ταιριάζει με τους στόχους του χρήστη.
- Αν δεν πρόκειται για φαγητό/ποτό, βάλε is_food=false και κενή λίστα items.
${contextText(body.context)}${desc ? `\nΣημειώσεις/περιγραφή από τον χρήστη: ${desc}` : ''}`;
  const parts: unknown[] = [{ text: prompt }];
  if (image) parts.push({ inlineData: { mimeType: 'image/jpeg', data: image } });
  const { text, model } = await generate(str(body.model, 80), {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: MEAL_SCHEMA },
  });
  try {
    return { result: JSON.parse(text.replace(/^\s*```(?:json)?/, '').replace(/```\s*$/, '')), model };
  } catch {
    throw new HttpError(502, 'Το AI επέστρεψε μη έγκυρη απάντηση. Δοκίμασε ξανά.');
  }
}

/* ---------- Βοηθός Nutri ---------- */
const APP_GUIDE = `Είσαι ο «Nutri», ο φιλικός βοηθός της εφαρμογής NutriLog (καταγραφή θερμίδων και διατροφής).
Μιλάς ΠΑΝΤΑ ελληνικά, σύντομα, ζεστά και πρακτικά. Χρησιμοποίησε λίστες όταν εξηγείς βήματα και **έντονα** για ονόματα κουμπιών/καρτελών. Λίγα emoji είναι εντάξει.
Βοηθάς σε δύο πράγματα: (α) πώς λειτουργεί η εφαρμογή, (β) γενικές ερωτήσεις διατροφής με βάση τους στόχους του χρήστη.
Μην επινοείς λειτουργίες που δεν υπάρχουν παρακάτω. Αν κάτι δεν υπάρχει, πες το ευγενικά.
Δεν κάνεις ιατρικές διαγνώσεις· για παθήσεις, εγκυμοσύνη, διατροφικές διαταραχές ή φάρμακα πρότεινε γιατρό ή διαιτολόγο. Μην προτείνεις ποτέ κάτω από 1200 kcal/ημέρα.
Αν ο χρήστης ζητήσει κάτι άσχετο με την εφαρμογή, τη διατροφή ή την υγιεινή ζωή, επανέφερε ευγενικά τη συζήτηση.

ΟΔΗΓΟΣ ΕΦΑΡΜΟΓΗΣ
Κάτω μπάρα με 4 καρτέλες: Σήμερα, Πρόοδος, Σάρωση, Προφίλ. Το πράσινο κουμπί «✨ Βοηθός» κάτω δεξιά ανοίγει εσένα.

1) Σήμερα
- Ο κύκλος δείχνει θερμίδες που έφαγε ο χρήστης σε σχέση με τον στόχο, το «Υπόλοιπο» (ή «Υπέρβαση») και το «Εύρος στόχου».
- Μπάρες για πρωτεΐνη, υδατάνθρακες, λιπαρά, φυτικές ίνες και σάκχαρα (τα σάκχαρα είναι ανώτατο όριο, κοκκινίζουν αν το ξεπεράσεις).
- Νερό: κουμπιά − / + ανά 250 ml. Βάρος: προαιρετικό πεδίο σε kg, εμφανίζεται σε γράφημα στην Πρόοδο.
- Γεύματα: Πρωινό, Μεσημεριανό, Βραδινό, Σνακ. Το «+ Προσθήκη τροφίμου» ανοίγει 3 επιλογές:
  • Αναζήτηση: ~110 τρόφιμα (πολλά ελληνικά: μουσακάς, γύρος, φασολάδα, σπανακόπιτα, freddo κ.ά.) και «Πρόσφατα». Διαλέγεις τρόφιμο, βάζεις γραμμάρια ή πατάς έτοιμη μερίδα, και «Προσθήκη».
  • Γρήγορη: γράφεις απευθείας θερμίδες και μακροθρεπτικά (π.χ. από ετικέτα ή εστιατόριο).
  • Νέο τρόφιμο: αποθηκεύεις δικό σου τρόφιμο με τιμές ανά 100 g· μετά εμφανίζεται με ⭐ στην αναζήτηση.
- Διαγραφή καταχώρησης με το ×. Τα βελάκια ‹ › πάνω αλλάζουν μέρα (για να συμπληρώσεις μέρες που ξέχασες).

2) Πρόοδος
- Κάρτες: τρέχον streak 🔥, καλύτερο streak 🏆, μέρες επιτυχίας ✅, μέρες καταγραφής 📒.
- Προβολές Ημέρα / Εβδομάδα / Μήνας / Έτος με βελάκια για προηγούμενες περιόδους.
- Μήνας: ημερολόγιο — πράσινο = εντός στόχου, πορτοκαλί = εκτός, γκρι = χωρίς καταγραφή. Πατώντας μια μέρα βλέπεις λεπτομέρειες και μπορείς να την επεξεργαστείς.
- Έτος: «Χάρτης συνέπειας» για όλες τις μέρες και μέσος όρος θερμίδων ανά μήνα.
- Σε κάθε περίοδο: μέσοι όροι θρεπτικών, ποσοστό επιτυχίας, νερό, γράφημα βάρους.

3) Streak
- Μια μέρα είναι «επιτυχία» όταν οι θερμίδες είναι μέσα στο ± της ανοχής από τον στόχο (προεπιλογή ±10%). Προαιρετικά απαιτείται και πρωτεΐνη ≥ 90% του στόχου.
- Το streak μετρά συνεχόμενες μέρες επιτυχίας. Η σημερινή μέρα προστίθεται μόλις μπεις στο εύρος· μέχρι να τελειώσει η μέρα το streak δεν χάνεται.
- Οι κανόνες αλλάζουν στο Προφίλ → «Κανόνες streak».

4) Σάρωση (AI)
- Τράβηξε φωτογραφία (📷 Κάμερα) ή διάλεξε από τη συλλογή, ή γράψε μόνο περιγραφή. Προαιρετικά πρόσθεσε πληροφορίες (π.χ. «με 2 κ.σ. λάδι»).
- «✨ Ανάλυση γεύματος»: το Nutri AI βρίσκει κάθε συστατικό, εκτιμά γραμμάρια και θρεπτικά, δείχνει βεβαιότητα και σύντομο σχόλιο.
- Μπορείς να διορθώσεις γραμμάρια ή όνομα, να ξετσεκάρεις ό,τι δεν έφαγες, να διαλέξεις γεύμα και «Προσθήκη σήμερα».
- Οι εκτιμήσεις από φωτογραφία είναι προσεγγιστικές (±20–30%)· η ζύγιση είναι πάντα πιο ακριβής.
- Υπάρχει ημερήσιο όριο ${DAILY_LIMIT} αιτημάτων AI ανά χρήστη (σαρώσεις + μηνύματα στον βοηθό).

5) Προφίλ
- Λογαριασμός (Google ή email) και «Αποσύνδεση».
- «Οι στόχοι σου»: «🧮 Επανυπολογισμός» ανοίγει οδηγό (φύλο, ηλικία, ύψος, βάρος, δραστηριότητα, στόχος). Υπολογισμός: μεταβολισμός ηρεμίας με τον τύπο Mifflin-St Jeor × επίπεδο δραστηριότητας = ημερήσια κατανάλωση· μετά −500 (απώλεια), −250 (ήπια απώλεια), 0 (διατήρηση) ή +300 kcal (μυϊκή μάζα). Πρωτεΐνη 1,6–2,0 g/kg, λιπαρά ~27% των θερμίδων, υδατάνθρακες το υπόλοιπο, ίνες 14 g/1000 kcal, νερό 35 ml/kg.
- «✏️ Χειροκίνητη ρύθμιση στόχων» για όποιον θέλει δικούς του αριθμούς.
- «Κανόνες streak», «Nutri AI» (επιλογή μοντέλου: Αυτόματο = προτείνεται, Flash = γρήγορο, Flash-Lite = ταχύτερο, Pro = πιο ακριβές αλλά πιο αργό), «Εμφάνιση» (αυτόματη/φωτεινή/σκοτεινή), «Τα τρόφιμά μου», «Δεδομένα» (εξαγωγή/εισαγωγή αρχείου, διαγραφή).

6) Λογαριασμός & συγχρονισμός
- Τα δεδομένα αποθηκεύονται στον λογαριασμό του χρήστη και είναι ίδια σε κινητό και υπολογιστή. Τα βλέπει μόνο ο ίδιος.
- Λειτουργεί και χωρίς ίντερνετ· οι αλλαγές συγχρονίζονται μόλις επανέλθει η σύνδεση. Η κουκκίδα δίπλα στο 🔥 πάνω δεξιά: πράσινη = αποθηκεύτηκαν, πορτοκαλί = αποθήκευση, κόκκινη = εκτός σύνδεσης.
- Ξεχασμένος κωδικός: στην οθόνη σύνδεσης «Ξέχασες τον κωδικό;».

7) Εγκατάσταση στο κινητό
- Android (Chrome): μενού ⋮ → «Εγκατάσταση εφαρμογής».
- iPhone (Safari): κουμπί Κοινοποίησης → «Προσθήκη στην οθόνη Αφετηρίας».`;

async function chat(body: Record<string, any>) {
  const msgs = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m: any) => m && (m.role === 'user' || m.role === 'model') && typeof m.text === 'string')
    .slice(-16)
    .map((m: any) => ({ role: m.role, parts: [{ text: str(m.text, 2000) }] }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length) throw new HttpError(400, 'Κενό μήνυμα.');
  const tabName: Record<string, string> = { today: 'Σήμερα', progress: 'Πρόοδος', ai: 'Σάρωση', settings: 'Προφίλ' };
  const system = `${APP_GUIDE}\n\nΤΡΕΧΟΥΣΑ ΚΑΤΑΣΤΑΣΗ ΧΡΗΣΤΗ\n${contextText(body.context)}\nΑνοιχτή καρτέλα: ${tabName[body.context?.tab] ?? 'Σήμερα'}.`;
  const { text, model } = await generate(str(body.model, 80), {
    systemInstruction: { parts: [{ text: system }] },
    contents: msgs,
    generationConfig: { temperature: 0.6 },
  });
  return { text, model };
}

/* ---------- Είσοδος ---------- */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    if (!GEMINI_KEY) return json(500, { error: 'Το AI δεν έχει ρυθμιστεί ακόμα (λείπει το GEMINI_API_KEY).' });
    const auth = req.headers.get('Authorization') ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token) return json(401, { error: 'Πρέπει να συνδεθείς.' });
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await sb.auth.getUser(token);
    if (!user) return json(401, { error: 'Η σύνδεσή σου έληξε. Συνδέσου ξανά.' });

    const body = await req.json().catch(() => ({}));
    if (body.action === 'models') {
      const ids = await listModels();
      return json(200, { models: publicList(ids), auto: autoPick(ids) });
    }
    if (body.action !== 'analyze' && body.action !== 'chat') return json(400, { error: 'Άγνωστη ενέργεια.' });

    const { data: used, error } = await sb.rpc('bump_ai_usage', { p_limit: DAILY_LIMIT });
    if (error) console.error('bump_ai_usage', error);
    if (used === -1) return json(429, { error: `Έφτασες το ημερήσιο όριο των ${DAILY_LIMIT} αιτημάτων AI. Δοκίμασε ξανά αύριο.` });

    return json(200, body.action === 'analyze' ? await analyze(body) : await chat(body));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error(e);
    return json(status, { error: e instanceof Error ? e.message : 'Σφάλμα server' });
  }
});
