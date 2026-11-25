# VOS Logistics website

One Netlify site (vos-logistics-jobs.netlify.app), published automatically from the `site/` folder of this repo.

| Page | What it is | Who can see it |
|---|---|---|
| `/` (also `/jobs`) | Job posting + application (Google JobPosting data, emails every applicant) | Everyone |
| `/sign/` | Independent Contractor Agreement + Liability Waiver signing | Everyone (links to the associate's account when logged in) |
| `/portal/` (also `/shifts`) | Associate portal: create account → approval → sign → pick shifts | Approved associates |
| `/admin/` | Applications, associates/roster, schedule, waivers, shift settings | Admins only |

Data lives in the Supabase project **Battery Schedule** (`xzlnzldolzqlhbqfgjeh`).
Database changes are in `supabase/migrations/`. The old live pages are backed up in `originals/`.
