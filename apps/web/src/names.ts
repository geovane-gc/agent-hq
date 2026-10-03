// Random names for new agents. Pure and dependency-free so the core can reuse it.

/** A broad, international pool of first names (computing pioneers first, as a nod to the trade). */
export const AGENT_NAMES = [
  'Ada', 'Alan', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Ken', 'Barbara', 'Edsger', 'Donald',
  'Frances', 'Hedy', 'Katherine', 'Dorothy', 'Mary', 'Radia', 'Sophie', 'Tim', 'Vint', 'Guido',
  'Bjarne', 'Anders', 'Yukihiro', 'Brendan', 'Larry', 'Niklaus', 'Tony', 'Leslie', 'Shafi', 'Annie',
  'Jean', 'Evelyn', 'Kathleen', 'Joan', 'Hal', 'Claude', 'John', 'Lynn', 'Fran', 'Adele',
  'Aiko', 'Akira', 'Amara', 'Amir', 'Ana', 'Anika', 'Arjun', 'Astrid', 'Aya', 'Bea',
  'Bruno', 'Camila', 'Carlos', 'Chen', 'Chidi', 'Chloe', 'Dalia', 'Daniel', 'Dara', 'Diego',
  'Elif', 'Elena', 'Emeka', 'Emil', 'Esther', 'Farah', 'Felix', 'Fatima', 'Freya', 'Gabriel',
  'Hana', 'Hamid', 'Hugo', 'Ines', 'Ingrid', 'Isaac', 'Ivan', 'Jada', 'Jamal', 'Jonas',
  'Jun', 'Kai', 'Kamala', 'Kenji', 'Kiran', 'Lara', 'Leila', 'Leon', 'Lina', 'Lucia',
  'Luca', 'Maya', 'Malik', 'Mateo', 'Mei', 'Mila', 'Nadia', 'Naveen', 'Nia', 'Nico',
  'Nina', 'Noor', 'Olga', 'Omar', 'Oscar', 'Priya', 'Rafael', 'Rania', 'Ravi', 'Rhea',
  'Rosa', 'Rui', 'Sadia', 'Samir', 'Sana', 'Santiago', 'Sara', 'Selin', 'Sven', 'Tariq',
  'Thiago', 'Tomas', 'Uma', 'Valentina', 'Vera', 'Wei', 'Xavier', 'Yara', 'Yusuf', 'Zara',
  'Zeynep', 'Zoe', 'Ayumi', 'Bilal', 'Carmen', 'Darius', 'Eitan', 'Femi', 'Greta', 'Hiro',
  'Imani', 'Joaquin', 'Kofi', 'Lucas', 'Mina', 'Nala', 'Otto', 'Paulo', 'Quinn', 'Renata',
  'Soren', 'Tala', 'Ugo', 'Vikram', 'Wanda', 'Ximena', 'Yasmin', 'Zane', 'Iris', 'Matilda',
  'Teodor', 'Lior', 'Anouk', 'Bodhi', 'Cyrus', 'Dilnoza', 'Eamon', 'Folake', 'Gael', 'Halima',
];

const norm = (name: string) => name.trim().toLowerCase();

/**
 * A name no agent uses yet. `taken` should hold every existing agent name (and,
 * for a re-roll, the name currently in the field so the dice never repeats).
 * Comparison ignores case and surrounding spaces. When the pool runs out, a
 * numbered variant ("Ada 2") keeps the result unique.
 */
export function randomAgentName(taken: Iterable<string>, rng: () => number = Math.random): string {
  const used = new Set([...taken].map(norm));
  const pool = [...new Set(AGENT_NAMES)];
  const free = pool.filter((n) => !used.has(norm(n)));
  if (free.length) return free[Math.floor(rng() * free.length)];
  const start = Math.floor(rng() * pool.length);
  for (let suffix = 2; ; suffix++) {
    for (let i = 0; i < pool.length; i++) {
      const candidate = `${pool[(start + i) % pool.length]} ${suffix}`;
      if (!used.has(norm(candidate))) return candidate;
    }
  }
}
