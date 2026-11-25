# VOS Logistics website

The website (https://alizeh-cyber.github.io/VOSLogistics/) is published by GitHub Pages from the `docs/` folder of this repo.

| Page | What it is | Who can see it |
|---|---|---|
| `/` (also `/jobs`) | Job posting + application (Google JobPosting data, emails every applicant) | Everyone |
| `/sign/` | Independent Contractor Agreement + Liability Waiver signing | Everyone (links to the associate's account when logged in) |
| `/portal/` (also `/shifts`) | Associate portal: schedule, my shifts, earnings, refer a friend, my account | Approved associates |
| `/admin/` | Applications, associates/roster, team list, payroll (upload Lime weekly PDF), referrals, schedule, waivers, shift settings | Admins only |

Data lives in the Supabase project **Battery Schedule** (`xzlnzldolzqlhbqfgjeh`).
Database changes are in `supabase/migrations/`. The old live pages are backed up in `originals/`.

## Weekly payroll
1. In `/admin/` → **Payroll**, upload Lime's "Logistics Provider Weekly Report" PDF.
2. New Lime names are matched to a person once; after that it's automatic.
3. Rent per task = the person's pay plan tier for that week's task count, minus $0.05 per active referral (never below $0). Edit any row's rent or bonus afterwards.
4. Associates see week, tasks and actual pay in their **Earnings** tab.
Referrals are added in **Referrals** when someone is referred. The $0.05 discount starts automatically the Monday after BOTH the referrer and the referred person have reached 200 total tasks (counted from uploaded weeks, plus a one-time "already had 200+ before payroll" mark) and lasts 3 months.
