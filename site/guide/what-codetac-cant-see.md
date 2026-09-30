# What codeTAC can't see

**What this page is for:** knowing the **limits** of codeTAC in plain words, so you know when an empty answer means “nothing there” and when it means “codeTAC could not look”.

codeTAC has two ways of looking at your app:

- **Watching it run** (the dossier): shows what really happened, but only what happened this time.
- **Reading the code** (Structure): shows everything the code says, but not what is decided only while the app runs.

Each one covers some of the other's blind spots. Here is what neither sees well.

## Apps it does not work with (yet)

- Django, and apps in PHP, Go or Ruby (Laravel, Rails…).
- Sites with only HTML and JavaScript, without a Node or Python server.
- Parts that run on Bun, Deno, Cloudflare Workers or in Next.js middleware. codeTAC warns you when it recognises them.
- Apps in production or that only exist in the cloud: codeTAC is for your computer, while you develop.
- Windows has not been tested yet.

## When watching the app run

- **Only this time.** A dossier shows what one action did. Code that runs only on other days, for other users or on errors will not appear until it happens.
- **In the browser**, you see the element clicked, its component and the path to each request, but not each browser function.
- **Services called straight from the browser** show up as browser requests, without the server's step-by-step.
- **Python apps:** functions are followed only with Python 3.12 or newer; threads created by hand are not linked to their request; Redis, MongoDB and Celery do not appear as outside services yet; hypercorn and granian give no dossier.

## When reading the code

The floor plan may miss an arrow, or put a file in **Unknown**, when:

- the code decides **while running** what to load or call: `import()` of a computed path, `require(variable)`, functions passed around as values, event emitters, queues, `eval`;
- a request's address is in a variable (the plan then says **comes from the variable …**, or **unknown** when the address is built while the app runs), or is made through a client of your own instead of `fetch`, `axios`, `ky` or `ofetch`;
- a function is called by something other than its name: `obj[name]()`, a method of a class instance;
- a function is inside another function (it counts as part of the outer one);
- routes are declared in unusual ways (in Node, codeTAC reads `app.get('/path', …)`, `router.post(…)`, `app.use('/prefix', router)`, Fastify's `register(…, { prefix })`, Next.js `route.ts` and `pages/api`);
- the code is inside `.vue` or `.svelte` files (they are listed as Interface);
- pages are files, not routes: only API endpoints count as routes.

Each topic page has its own **What it can't tell you** section with the details:

- [What leaves my computer?](/guide/what-leaves-my-computer#what-it-can-t-tell-you)
- [Are my secrets safe?](/guide/are-my-secrets-safe#what-it-can-t-tell-you)
- [My database tables](/guide/my-database-tables#what-it-can-t-tell-you)
- [Is my project getting messy?](/guide/is-my-project-getting-messy#what-it-can-t-tell-you)
- [What did the AI change?](/guide/what-did-the-ai-change#what-it-can-t-tell-you)
- [Python apps](/guide/python-apps#what-it-can-t-tell-you)

## The two together

When you use your app with Structure open, the path of each action is lit on the plan. An arrow that **really happened** but was not in the code as read shows up in orange as **seen only at run time**. So the more of your app you use, the fewer blind spots remain.

## An empty list is not a guarantee

“No alerts” means codeTAC found none **in what it can see**. It is a strong hint, not a security audit. If your app handles money or personal data, have a person review it too.
