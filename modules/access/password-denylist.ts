/**
 * Base words that appear at the top of every published breach corpus, plus the
 * keyboard runs and the words specific to this deployment.
 *
 * This is not a list of *passwords* — the length floor already rejects almost
 * every entry on its own. It is a list of **bases**: `validatePasswordShape`
 * strips padding digits and symbols, undoes common letter substitutions, and
 * collapses repetition before comparing, so `P@ssw0rd1234!`,
 * `dragondragondragon`, and `Sunshine!!!!!!!!` are all caught by the single
 * entry they are built from. That is the failure mode a length floor alone
 * invites: a weak word made long by padding it.
 */
export const COMMON_PASSWORD_BASES: ReadonlySet<string> = new Set([
  // Keyboard runs and adjacent-key walks.
  "qwerty", "qwertyuiop", "qwertz", "qwertzuiop", "azerty", "azertyuiop",
  "asdfgh", "asdfghjkl", "zxcvbn", "zxcvbnm", "qazwsx", "qazwsxedc",
  "wasdwasd", "poiuytrewq", "lkjhgfdsa", "mnbvcxz", "abcdef", "abcdefg",
  "abcdefgh", "abcdefghij", "abcdefghijklmnop",
  // The perennial top of every corpus.
  "password", "passwort", "passe", "pass", "motdepasse", "contrasena",
  "letmein", "welcome", "login", "admin", "administrator", "root", "guest",
  "user", "test", "temp", "changeme", "default", "secret", "access", "master",
  "manager", "supervisor", "superuser", "system", "server", "database",
  "iloveyou", "trustno", "trustnoone", "whatever", "nothing", "freedom",
  "loveme", "lovely", "forever", "friends", "family", "hello", "helloworld",
  "letmeinnow", "iloveme", "ihateyou", "killer", "monkey", "dragon", "shadow",
  "sunshine", "princess", "flower", "starwars", "startrek", "superman",
  "batman", "spiderman", "pokemon", "matrix", "maverick", "phoenix", "ninja",
  "samurai", "warrior", "hunter", "ranger", "raider", "cowboy", "buster",
  "gandalf", "merlin", "wizard", "legolas", "aragorn", "skywalker",
  // Sport, cars, animals, colours — the usual clusters.
  "football", "baseball", "basketball", "soccer", "hockey", "cricket",
  "rugby", "golfer", "tennis", "yankees", "cowboys", "steelers", "liverpool",
  "arsenal", "chelsea", "barcelona", "juventus", "mustang", "corvette",
  "camaro", "ferrari", "porsche", "harley", "yamaha", "honda", "toyota",
  "diamond", "silver", "golden", "orange", "purple", "yellow", "scarlet",
  "cheese", "banana", "chicken", "pepper", "cookie", "chocolate", "coffee",
  "whisky", "whiskey", "guinness", "tigger", "kitten", "puppy", "bulldog",
  "bigdog", "snoopy", "garfield", "mickey", "minnie", "eagle", "falcon",
  "tiger", "lion", "panther", "cobra", "viper", "husky", "dolphin",
  // Names that recur across corpora.
  "michael", "jennifer", "jessica", "michelle", "matthew", "daniel",
  "andrew", "joshua", "charlie", "thomas", "robert", "richard", "george",
  "patrick", "martin", "ashley", "amanda", "samantha", "nicole", "brandon",
  "jordan", "jonathan", "anthony", "william", "elizabeth", "hannah",
  "victoria", "sophie", "olivia", "isabella", "bailey", "ginger", "summer",
  "sabrina", "melissa", "heather", "rebecca", "stephanie", "catherine",
  // Seasons, dates, and pure padding words.
  "spring", "summertime", "autumn", "winter", "christmas", "halloween",
  "birthday", "holiday", "vacation", "weekend", "monday", "friday",
  "january", "february", "december", "newyear", "millennium",
  // Profanity and throwaways that stay near the top of every list.
  "asshole", "fuckyou", "fuckoff", "bullshit", "bitch", "sexy", "hotstuff",
  "playboy", "hooters", "boobies", "biteme", "blowme", "iamgod", "godisgood",
  // Words specific to this deployment, which are the first thing anyone tries.
  "imsda", "imsdaevents", "imsdaevent", "events", "event", "eventstaff",
  "registration", "register", "attendee", "volunteer", "conference",
  "retreat", "womensretreat", "convention", "checkin", "frontdesk", "staff",
  "dance", "dancers", "dancing", "ballroom", "worship", "ministry", "church",
]);

/**
 * Digits that stand in for letters. Applied before the denylist comparison so
 * `p4ssw0rd` and `password` are the same string to this module.
 */
export const LEET_SUBSTITUTIONS: ReadonlyMap<string, string> = new Map([
  ["0", "o"], ["1", "i"], ["3", "e"], ["4", "a"], ["5", "s"], ["6", "g"],
  ["7", "t"], ["8", "b"], ["9", "g"], ["@", "a"], ["$", "s"], ["!", "i"],
  ["|", "l"], ["+", "t"], ["(", "c"], ["€", "e"], ["£", "l"],
]);
