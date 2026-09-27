# NutriLog — Ρύθμιση server (Supabase)

Η εφαρμογή χρησιμοποιεί το **Supabase** (δωρεάν πλάνο) για:
- **Σύνδεση χρηστών**: Google και email/κωδικός
- **Αποθήκευση δεδομένων** ανά χρήστη, συγχρονισμένα σε όλες τις συσκευές
- **Κρυφό Gemini API key**: το κλειδί βρίσκεται μόνο στον server (Edge Function `ai`) και δεν φτάνει ποτέ στον browser

## 1. Δημιουργία project
1. Κάνε λογαριασμό στο https://supabase.com και πάτα **New project**.
2. Όνομα `nutrilog`, region **Central EU (Frankfurt)**, και ένας ισχυρός database password (κράτα τον κάπου).
3. Από **Project Settings → API Keys** χρειάζεσαι:
   - το **Project URL** (`https://xxxx.supabase.co`)
   - το **Publishable key** (ή το παλιό *anon public* key)

   Αυτά τα δύο μπαίνουν στο `config.js`. Είναι δημόσια από τη φύση τους, οπότε δεν υπάρχει πρόβλημα να φαίνονται.

## 2. Βάση δεδομένων
**SQL Editor → New query**: επικόλλησε όλο το `supabase/schema.sql` και πάτα **Run**.

## 3. Gemini key (κρυφό)
**Edge Functions → Secrets → Add new secret**:
- `GEMINI_API_KEY` = το κλειδί σου από το https://aistudio.google.com/apikey
- *(προαιρετικό)* `AI_DAILY_LIMIT` = αιτήματα AI ανά χρήστη την ημέρα (προεπιλογή 60)

## 4. Edge Function `ai`
Με το Supabase CLI:
```
npx supabase login
npx supabase functions deploy ai --project-ref <PROJECT_REF> --no-verify-jwt
```
Το `--no-verify-jwt` χρειάζεται επειδή η function ελέγχει μόνη της τον χρήστη.

## 5. Σύνδεση με email
**Authentication → Sign In / Providers → Email**: ενεργό.

Το ενσωματωμένο email του Supabase στέλνει ελάχιστα email την ώρα. Για πολλούς χρήστες:
- είτε απενεργοποίησε το **Confirm email**, ώστε η εγγραφή να γίνεται αμέσως,
- είτε σύνδεσε δωρεάν SMTP (π.χ. Resend) στο **Authentication → Emails → SMTP Settings**. Χρειάζεται και για το «Ξέχασες τον κωδικό;».

## 6. Σύνδεση με Google
1. https://console.cloud.google.com → νέο project → **Google Auth Platform**.
2. **Branding**: όνομα εφαρμογής `NutriLog` και το email σου. **Audience**: External.
3. **Clients → Create client → Web application**.
   - Authorized JavaScript origins: `https://fanistsob2001.github.io`
   - Authorized redirect URIs: `https://<PROJECT_REF>.supabase.co/auth/v1/callback`
4. Αντέγραψε **Client ID** και **Client secret** στο Supabase: **Authentication → Sign In / Providers → Google** → Enable.

## 7. Διευθύνσεις επιστροφής
**Authentication → URL Configuration**:
- Site URL: `https://fanistsob2001.github.io/NutriLog/`
- Redirect URLs: `https://fanistsob2001.github.io/NutriLog/**` και `http://localhost:5178/**`

## Αλλαγή κλειδιού ή ορίου αργότερα
Αλλάζεις την τιμή του secret στο **Edge Functions → Secrets**. Δεν χρειάζεται νέα έκδοση της εφαρμογής.
