// Apply the saved theme before first paint (a separate file so the Content-Security-Policy can forbid inline scripts).
try { document.querySelector('meta[name="color-scheme"]').content = localStorage.getItem('color-scheme') ?? 'light dark'; } catch {}
