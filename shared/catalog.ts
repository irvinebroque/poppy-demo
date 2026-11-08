import type { SearchResult } from "./private-search";

export const products = {
  "stormline-shell": {
    name: "Stormline Shell",
    price: 180,
    color: "#657b68",
    lining: "#4c5f4e",
    description: "A lightweight waterproof shell for wet trails and everyday weather.",
    details: ["Waterproof outer fabric", "Adjustable hood and cuffs", "Two zippered hand pockets"],
    subtitle: "Lightweight weather protection",
  },
  "stormline-insulated": {
    name: "Stormline Insulated Jacket",
    price: 250,
    color: "#c5a276",
    lining: "#9f7c53",
    description:
      "The weather protection of our Stormline shell, with added insulation for colder days.",
    details: ["Waterproof outer fabric", "Warm insulated lining", "Adjustable hood and cuffs"],
    subtitle: "Extra warmth for colder days",
  },
};

export function searchCatalog(query: string, origin: string): SearchResult[] {
  const words = query.toLowerCase().split(/\W+/).filter(Boolean);
  const warmth = words.some((word) => /^(warm|warmer|warmth|insulated|cold|colder)$/.test(word));

  return Object.entries(products).flatMap(([id, item]) => {
    const matches = warmth
      ? id === "stormline-insulated"
      : words.some((word) =>
          `${id} ${item.name} ${item.description} ${item.details.join(" ")}`
            .toLowerCase()
            .includes(word),
        );

    return matches
      ? [
          {
            id,
            name: item.name,
            price: item.price,
            description: item.description,
            url: `${origin}/products/${id}`,
          },
        ]
      : [];
  });
}
