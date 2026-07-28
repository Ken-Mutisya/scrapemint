# Internet Infrastructure Data: Networks, IP Ranges, Peering

Who actually owns and routes a piece of the internet. Give a network number, an IP address or a country code, and get the holder, the address space they announce, the networks they connect to, and how long they have been visible in the global routing table. No key, no login, no proxy.

## Four modes

**Network** returns one row per network: holder, registry block, IPv4 prefixes and addresses announced, IPv6 prefixes, observed neighbours, first and last seen in routing, and routing visibility. An IP address is resolved to the network announcing it, and the covering prefix is reported.

**Prefixes** returns every IP range a network announces, with its address count and the dates it has been seen.

**Peers** returns each neighbouring network, marked `upstream`, `downstream` or `uncertain`, with the number of peering sessions observed over IPv4 and IPv6.

**Country** returns every network registered to a two letter country code, with the country's total networks and address blocks.

## Example input

```json
{
  "mode": "network",
  "resources": ["AS15169", "8.8.8.8"]
}
```

Who buys transit from a network:

```json
{
  "mode": "peers",
  "resources": ["AS15169"],
  "peerType": "downstream"
}
```

## Three things worth knowing

**Address counts are IPv4 only, deliberately.** A v4 prefix covers a countable number of addresses, so a /24 is 256 and a network's total is a meaningful figure. A v6 /32 covers about 79 octillion addresses, so adding the two together produces a number that means nothing at all. IPv6 is therefore reported as a count of prefixes, which is what the source publishes and what engineers actually compare.

**Upstream and downstream are inferred, and often uncertain.** The source labels relationships left and right, which this actor translates to upstream, meaning they provide transit, and downstream, meaning they buy it. For Google's network, 140 neighbours read as upstream, 20 as downstream and 174 as uncertain, and that last group is honestly labelled rather than guessed at.

**A withdrawn IP range keeps its record.** Ranges that stopped being announced still appear in the source with a timeline showing when they ended. They are excluded by default and, when included, marked with `currentlyAnnounced` false rather than silently mixed in with live routes.

## Speed and cost

Holder names cost one extra request per network, so a large country run is much faster with `includeHolderNames` off. Lookups are cached within a run, so a network that appears repeatedly is only resolved once.

Pay per row, `$0.004`. The first 2 rows of every run are free. Unreadable inputs, networks with no routing data and empty countries return a free note and are never charged.

## Attribution

Routing data from RIPE NCC.

## Related actors

- **DNS Records Checker** and **Domain Intelligence** for the naming and registry layers
- **SSL Subdomain Finder** for certificate transparency records
- **Business Locations Worldwide** and **Company Data Worldwide** for the organisations behind the networks
