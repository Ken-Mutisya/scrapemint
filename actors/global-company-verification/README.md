# Global Company Verification: Registry & Ownership Lookup

Check that a company legally exists, in any country, against GLEIF - the official global Legal Entity Identifier registry used by banks and regulators worldwide. Around 2.5 million legal entities, one authoritative record each.

Give it company names or LEI codes, get back the official registered identity: exact legal name, registered and headquarters address, entity status, the local business registry number, and who owns the company.

## What you get

One row per verified entity:

| Field | Description |
| --- | --- |
| `lei` | The entity's 20-character Legal Entity Identifier |
| `legalName`, `otherNames` | Official registered name and trading names |
| `entityStatus` | ACTIVE, INACTIVE (merged, dissolved...) |
| `jurisdiction`, `legalFormId` | Where and in what legal form it is registered |
| `localRegistryId`, `registrationAuthority` | The entity's number in its national business registry |
| `legalAddress...`, `hqAddress...` | Registered and headquarters addresses |
| `directParentName`, `directParentLei` | Who owns it (accounting consolidation) |
| `ultimateParentName`, `ultimateParentLei` | The top of the ownership chain |
| `leiRegistrationStatus`, `leiNextRenewal` | How fresh the record is |

## Typical uses

- **Supplier and vendor onboarding**: does this entity exist, where is it registered, and under which registry number?
- **Invoice fraud checks**: the name and address on the invoice should match the registry record.
- **Sales intelligence**: resolve an enterprise prospect to its legal entity and ultimate parent group.
- **KYC pre-screening**: pull the official identity before the expensive full check.
- **Corporate research**: map ownership chains across borders.

Pairs naturally with sanctions and watchlist screening: verify the entity, then screen it.

## Honest coverage note

LEIs are mandatory for entities active in financial markets: banks, funds, insurers, listed companies, bond issuers, and most mid-size and large corporates that trade or borrow. A small local business that never touched a financial market may legitimately have no LEI. A no-match result means "not in the LEI system", not "does not exist" - and it costs you nothing.

## Pricing

You pay per verified company row (`company_found`). Searches with no match are free. The first 2 rows of every run are free.

## Input example

```json
{
    "queries": ["Volkswagen AG", "Safaricom", "HWUPKR0MPOU8FGXBT394"],
    "country": "",
    "activeOnly": true,
    "includeParents": true,
    "maxResultsPerQuery": 3
}
```

## Notes

- Data comes from GLEIF's public API. No API key, no login, no browser.
- Parent relationships are as reported to GLEIF; a missing parent usually means the entity is itself the top of its chain, or reports an exception (natural persons, no consolidation).
- GLEIF rate-limits per IP; the actor paces itself, retries once on a limit, and stops cleanly with partial data if the limit persists (finished rows are kept).
