// About the name and the developer. Edit freely: this is the only file that holds personal text.
// Facts come from the public GitHub profile and portfolio (github.com/Kotti13); no private details are used.

export const NAME = {
  line: 'Zoyra = Zoya + Aura',
  zoya: 'Zoya is a name often read as “life”: someone alive, bright, full of energy.',
  aura: 'Aura is the glow a person gives off, the feeling in the room when they walk in.',
  together: 'Put together, Zoyra is the life and the glow of music: the song that makes a room feel different, shared with the people who make it matter.',
};

export const DEV = {
  name: 'K. Kottai Samy',
  short: 'Kottai Samy',
  role: 'Full-stack developer',
  place: 'Chennai, India',
  photo: '/assets/ks.jpg',
  github: 'https://github.com/Kotti13',
  portfolio: 'https://kotti13.github.io/My-portfolio/',
  headline: 'One developer, one idea: music is better together.',
  intro:
    'I started in mechanical engineering and found my way to the web. Zoyra is the biggest thing I have built: a social music app for phones, the backend that plays the songs, and this website, all in one public repository.',
  story: [
    'I trained as a mechanical engineer. Engineering teaches you to ask what will break, and how you will know. When I moved into software, I kept that habit: build the thing, then test it until it stops surprising you.',
    'After a diploma in Mechanical Engineering, I spent nine months at FSSA Software Academy (Freshworks CSR program), learning to build for the web. Then I built: Ticketboxx, a fitness tracker, a tech community blog, a site for an educational trust, and then, in 2026, Zoyra.',
    'Zoyra is where it all came together. It is a mobile app in TypeScript and React Native, a database and sign-in on Supabase, a Python gateway and a Java service that find and play songs, share links on Vercel, and a backend that runs on a spare laptop behind a Cloudflare tunnel. I wanted to understand every layer, so I built every layer.',
  ],
  facts: [
    { k: 'Based in', v: 'Chennai, India' },
    { k: 'Background', v: 'Diploma, Mechanical Engineering' },
    { k: 'Trained at', v: 'FSSA Software Academy (9 months)' },
    { k: 'Builds with', v: 'TypeScript, React Native, Python, Supabase' },
    { k: 'On GitHub', v: '33 public repositories' },
    { k: 'Keeps learning', v: 'React Native, TypeScript, GSAP' },
  ],
};

export const TIMELINE = [
  { when: 'Before code', title: 'Mechanical engineering', text: 'A diploma in Mechanical Engineering: how things are made, and how they fail.' },
  { when: '2025', title: 'FSSA Software Academy', text: 'Nine months of web development training (Freshworks CSR program), then a run of small projects in React and JavaScript.' },
  { when: '2025', title: 'Web projects, shipped', text: 'Ticketboxx, a fitness tracker, a tech community blog and a website for an educational trust, each deployed live.' },
  { when: '2026', title: 'Zoyra', text: 'A full social music app: the phone app, a music backend, share links, and this website.' },
  { when: 'Now', title: 'Making it real', text: 'Hosting it properly, polishing it, and getting it into people’s hands, one build at a time.' },
];

export const NUMBERS = [
  { value: '190+', label: 'app screens' },
  { value: '15', label: 'server functions' },
  { value: '50+', label: 'database migrations' },
  { value: '5', label: 'services and sites' },
];

export const PRINCIPLES = [
  { icon: 'play', title: 'Build the whole thing', text: 'App, backend, database, share links, website, hosting. If a layer is missing, the product does not work, so I build it.' },
  { icon: 'shield', title: 'Private by default', text: 'Encrypted chats, a read-only public site, private playlists that stay private, and no personal details in crash reports.' },
  { icon: 'eq', title: 'Test the boring parts', text: 'The gateway, the share site and this website each have automated tests, and every change runs a type check and the checks in CI.' },
  { icon: 'note', title: 'Write it down', text: 'Hosting steps, a launch checklist and the reasons behind choices live in the repository, so the next person (or me, in six months) can pick it up.' },
];

export const STACK_CHIPS = ['TypeScript', 'React Native', 'Expo', 'Supabase', 'PostgreSQL', 'Python', 'FastAPI', 'Java', 'Docker', 'Cloudflare', 'Vercel', 'GitHub Actions'];

// Real repositories (github.com/Kotti13). `live` is the deployed site when there is one.
export const PROJECTS = [
  { name: 'Zoyra', lang: 'TypeScript · Python', tag: 'Social music app', repo: 'Zoyra', live: 'https://zoyra.site' },
  { name: 'Ticketboxx', lang: 'JavaScript', tag: 'Web app', repo: 'ticketboxx', live: 'https://ticketboxx.vercel.app' },
  { name: 'Tech Community Blog', lang: 'TypeScript', tag: 'Web app', repo: 'Tech_Community_Blog', live: 'https://mindshare-eight.vercel.app' },
  { name: 'Star Educational Trust', lang: 'TypeScript', tag: 'Website', repo: 'Star_Educational_Trust', live: 'https://star-educational-trust.vercel.app' },
  { name: 'Fitness Tracker', lang: 'JavaScript', tag: 'Web app', repo: 'fitness_tracker_project', live: 'https://fitness-tracker-plum.vercel.app/' },
  { name: 'Cricscore', lang: 'TypeScript', tag: 'App', repo: 'cricscore', live: '' },
];
