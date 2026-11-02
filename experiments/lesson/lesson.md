---
scenes: [scenes]
lexicon: [lexicon.json]
voice: af_heart
speed: 1.0
---

## title-card 0
This is how a browser finds a website. It stops to ask you things along the way, so click the drawing when it asks.

## lookup 0 | The path of one lookup
This is DNS, the Domain Name System, and this is the path of one lookup. Your browser and a resolver ask the questions. A root server, a TLD server and an authoritative server answer them.

## lookup 1
You type example.com. The browser has no address for that name, so it asks the resolver, usually run by your internet provider.

## lookup 1 ? Which server does the resolver ask first?
The resolver now has to find the answer itself. Which server does the resolver ask first? Click it.

### right root
Right. Every resolver ships with the addresses of the root servers, so that is where every search can begin.

### wrong tld + guess-tld guess-tld-t
The TLD server knows who runs .com, but the resolver has no address yet for that server. Something else has to point the way there first.

### wrong auth + guess-auth guess-auth-t
The authoritative server does hold the answer, but the resolver has no address yet for it. Finding that server is what the rest of this walk is for.

### again
Try another one. Which server's address does the resolver already know?

## lookup 2
So the resolver starts at the top. It asks a root server: example.com?

## lookup 3
The root server does not know, but it knows who runs .com. Its answer: ask the .com server.

## lookup 4
So the resolver asks the TLD server for .com: example.com?

## lookup 5
That server points one level down. Ask the example.com server.

## lookup 5 ? Which server holds the address for example.com?
Two servers have answered now, and neither gave an address. Which server holds the address for example.com? Click it.

### right auth
Right. The authoritative server is the one that holds the records for example.com.

### wrong root + again-root again-root-t
The root server only knows who runs each ending, like .com. Asked twice, it gives the same answer again.

### wrong tld + again-tld again-tld-t
The TLD server only knows who runs each name under .com. Asked twice, it gives the same answer again, a pointer one level down.

### again
Try another one. Which server has not been asked yet?

## lookup 6
So the resolver asks the authoritative server: example.com?

## lookup 7
This one knows. The address is 192.0.2.10.

## lookup 8
The resolver hands 192.0.2.10 back to the browser, and the page starts to load.

## lookup 9
The resolver also keeps the answer in its cache: example.com is at 192.0.2.10.

## lookup 10 ? Who answers the second person?
A second person now asks for example.com. Who answers the second person? Click it.

### right cache + a-browser a-browser-t
Right. The cache still holds example.com at 192.0.2.10, so the resolver answers at once, and none of the servers hear about it.

### wrong root + waste-root waste-root-t
Asking the root server would work, but the resolver would walk the whole chain again for an answer it already has. That is a wasted trip.

### wrong auth + waste-auth waste-auth-t
The authoritative server would give the right address, but the resolver already has it. That is a wasted trip, and the answer would come back later.

### again
Try another one. Look at what the resolver just kept.

## caching 1
A cached answer skips all three servers, so it comes back in a millisecond or two.

## caching 2
The busy servers get fewer questions. A root server would drown if every lookup started there.

## caching 3
Every answer expires after a set time, which the authoritative server picks. A changed address spreads once the old answers run out.

## takeaway 0
The first lookup walks the whole chain. After that, the cache answers.

## end 0
That is DNS: how a name becomes an address.
