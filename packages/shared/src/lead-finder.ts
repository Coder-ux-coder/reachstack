// Lead Finder vocabularies. Filter values match the public API so saved searches and API clients interoperate.

export const LF_DEPARTMENTS = ["Engineering", "Finance & Administration", "Human Resources", "IT & IS", "Marketing", "Operations", "Sales", "Support", "Other"] as const;
export const LF_LEVELS = ["C-Level", "VP-Level", "Director-Level", "Manager-Level", "Staff", "Entry level", "Mid-Senior level", "Director", "Associate", "Owner", "Executive", "Manager", "Senior", "Chief X Officer (CxO)", "Internship", "Vice President (VP)", "Unpaid / Internship", "Partner"] as const;

/** Employee-count bands and their inclusive ranges. */
export const EMPLOYEE_BANDS: Record<string, [number, number]> = {
  "0 - 25": [0, 25],
  "25 - 100": [25, 100],
  "100 - 250": [100, 250],
  "250 - 1000": [250, 1000],
  "1K - 10K": [1000, 10000],
  "10K - 50K": [10000, 50000],
  "50K - 100K": [50000, 100000],
  "> 100K": [100000, Number.MAX_SAFE_INTEGER],
};

export const REVENUE_BANDS = ["$0 - 1M", "$1 - 10M", "$10 - 50M", "$50 - 100M", "$100 - 250M", "$250 - 500M", "$500M - 1B", "> $1B"] as const;

export const LF_NEWS_TYPES = ["launches", "expands_offices_to", "hires", "partners_with", "leaves", "receives_financing", "recognized_as", "closes_offices_in", "is_developing", "has_issues_with", "promotes", "opens_new_location", "receives_award", "acquires", "invests_into_assets", "signs_new_client", "increases_headcount_by", "retires_from", "invests_into", "integrates_with", "expands_facilities", "goes_public", "sells_assets_to", "identified_as_competitor_of", "decreases_headcount_by", "expands_offices_in", "files_suit_against", "merges_with"] as const;
export const FUNDING_TYPES = ["angel", "seed", "pre_seed", "series_a", "pre_series_a", "series_b", "pre_series_b", "series_c", "pre_series_c", "series_d", "pre_series_d", "series_e", "pre_series_e", "series_f", "pre_series_f", "series_g", "pre_series_g", "series_h", "pre_series_h", "series_i", "pre_series_i", "series_j", "pre_series_j"] as const;

/** Industry -> sub-industries. */
export const INDUSTRY_TREE: Record<string, string[]> = {
  "Agriculture & Mining": [
    "Dairy",
    "Farming",
    "Fishery",
    "Food & Beverages",
    "Food Production",
    "Mining & Metals",
    "Paper & Forest Products",
    "Ranching",
    "Tobacco"
  ],
  "Business Services": [
    "Alternative Dispute Resolution",
    "Animation",
    "Business Supplies and Equipment",
    "Design",
    "Environmental Services",
    "Events Services",
    "Executive Office",
    "Facilities Services",
    "Fund-Raising",
    "Graphic Design",
    "Human Resources",
    "Import and Export",
    "Individual & Family Services",
    "Information Services",
    "International Trade and Development",
    "Law Practice",
    "Legal Services",
    "Management Consulting",
    "Market Research",
    "Marketing and Advertising",
    "Outsourcing/Offshoring",
    "Professional Training & Coaching",
    "Program Development",
    "Public Relations and Communications",
    "Public Safety",
    "Security and Investigations",
    "Staffing and Recruiting",
    "Think Tanks",
    "Translation and Localization",
    "Writing and Editing"
  ],
  "Computers & Electronics": [
    "Computer Games",
    "Computer Hardware",
    "Computer Networking",
    "Consumer Electronics",
    "Semiconductors"
  ],
  "Consumer Services": [
    "Consumer Goods",
    "Consumer Services",
    "Education Management"
  ],
  "Education": [
    "E-Learning",
    "Higher Education",
    "Primary/Secondary Education",
    "Research"
  ],
  "Energy & Utilities": [
    "Oil & Energy",
    "Renewables & Environment",
    "Utilities"
  ],
  "Financial Services": [
    "Accounting",
    "Banking",
    "Capital Markets",
    "Financial Services",
    "Insurance",
    "Investment Banking",
    "Investment Management",
    "Venture Capital & Private Equity"
  ],
  "Government": [
    "Defense & Space",
    "Government Administration",
    "Government Relations",
    "International Affairs",
    "Judiciary",
    "Law Enforcement",
    "Legislative Office",
    "Military",
    "Museums and Institutions",
    "Public Policy"
  ],
  "Healthcare, Pharmaceuticals, & Biotech": [
    "Alternative Medicine",
    "Biotechnology",
    "Health, Wellness and Fitness",
    "Hospital & Health Care",
    "Medical Devices",
    "Medical Practice",
    "Mental Health Care",
    "Pharmaceuticals",
    "Veterinary"
  ],
  "Manufacturing": [
    "Automotive",
    "Aviation & Aerospace",
    "Chemicals",
    "Electrical/Electronic Manufacturing",
    "Furniture",
    "Industrial Automation",
    "Machinery",
    "Mechanical or Industrial Engineering",
    "Plastics",
    "Railroad Manufacture",
    "Shipbuilding",
    "Textiles"
  ],
  "Media & Entertainment": [
    "Broadcast Media",
    "Media Production",
    "Motion Pictures and Film",
    "Music",
    "Newspapers",
    "Online Media",
    "Printing",
    "Publishing"
  ],
  "Non-Profit": [
    "Civic & Social Organization",
    "Libraries",
    "Non-Profit Organization Management",
    "Philanthropy",
    "Political Organization",
    "Religious Institutions"
  ],
  "Other": [
    "Arts and Crafts",
    "Nanotechnology"
  ],
  "Real Estate & Construction": [
    "Architecture & Planning",
    "Building Materials",
    "Civil Engineering",
    "Commercial Real Estate",
    "Construction",
    "Glass, Ceramics & Concrete",
    "Real Estate"
  ],
  "Retail": [
    "Apparel & Fashion",
    "Cosmetics",
    "Luxury Goods & Jewelry",
    "Retail",
    "Supermarkets"
  ],
  "Software & Internet": [
    "Computer & Network Security",
    "Computer Software",
    "Information Technology and Services",
    "Internet"
  ],
  "Telecommunications": [
    "Telecommunications",
    "Wireless"
  ],
  "Transportation & Storage": [
    "Airlines/Aviation",
    "Logistics and Supply Chain",
    "Maritime",
    "Package/Freight Delivery",
    "Packaging and Containers",
    "Transportation/Trucking/Railroad",
    "Warehousing"
  ],
  "Travel, Recreation, and Leisure": [
    "Entertainment",
    "Fine Art",
    "Gambling & Casinos",
    "Hospitality",
    "Leisure, Travel & Tourism",
    "Performing Arts",
    "Photography",
    "Recreational Facilities and Services",
    "Restaurants",
    "Sporting Goods",
    "Sports",
    "Wine and Spirits"
  ],
  "Wholesale & Distribution": [
    "Wholesale"
  ]
};
export const INDUSTRIES = Object.keys(INDUSTRY_TREE);

export const SIGNAL_TYPES = ["linkedin_post_company", "linkedin_post_contact", "linkedin_comment", "twitter_post_company", "twitter_post_contact", "youtube_company", "youtube_contact", "reddit_buying_intent", "reddit_pain_point", "reddit_churn_risk", "reddit_competitor_mention", "glassdoor_negative", "glassdoor_positive", "website_product_launch", "website_pricing_change", "website_expansion", "website_executive_change", "website_funding", "website_partnership", "website_compliance", "website_technology_adoption", "job_change", "promotion", "work_anniversary", "traffic_surge", "traffic_decline"] as const;


/** Email-finder providers accepted in a custom waterfall ("custom_flow"). */
export const WATERFALL_PROVIDERS = ["instantly", "findymail", "leadmagic", "icypeas", "prospeo", "contactout", "wiza", "bettercontact"] as const;

/** Maps a raw seniority/level string onto the canonical level filter values. */
export function levelOf(title: string | null | undefined): (typeof LF_LEVELS)[number] {
  const t = (title ?? "").toLowerCase();
  if (/\b(ceo|cto|cfo|coo|cmo|cio|cro|chief|founder|co-founder|president)\b/.test(t)) return "C-Level";
  if (/\b(vp|vice president|svp|evp)\b/.test(t)) return "VP-Level";
  if (/\b(director|head of)\b/.test(t)) return "Director-Level";
  if (/\b(manager|lead|supervisor)\b/.test(t)) return "Manager-Level";
  if (/\b(intern|internship|trainee)\b/.test(t)) return "Internship";
  if (/\b(owner|partner|principal)\b/.test(t)) return "Owner";
  if (/\b(junior|associate|assistant|entry)\b/.test(t)) return "Entry level";
  if (/\b(senior|sr\.?|staff)\b/.test(t)) return "Senior";
  return "Staff";
}

/** Maps a job title onto the department filter values. */
export function departmentOf(title: string | null | undefined): (typeof LF_DEPARTMENTS)[number] {
  const t = (title ?? "").toLowerCase();
  if (/\b(engineer|engineering|developer|software|devops|architect|cto|technical|data scien)/.test(t)) return "Engineering";
  if (/\b(finance|financial|accounting|accountant|controller|cfo|treasur|payroll)/.test(t)) return "Finance & Administration";
  if (/\b(hr|human resources|people|talent|recruit)/.test(t)) return "Human Resources";
  if (/\b(it |it$|information technology|systems admin|security|infrastructure|cio|network)/.test(t)) return "IT & IS";
  if (/\b(marketing|brand|growth|content|seo|demand gen|cmo|communications)/.test(t)) return "Marketing";
  if (/\b(operations|ops|coo|supply chain|logistics|procurement)/.test(t)) return "Operations";
  if (/\b(sales|account executive|business development|bdr|sdr|revenue|cro|partnerships)/.test(t)) return "Sales";
  if (/\b(support|customer success|customer service|helpdesk)/.test(t)) return "Support";
  return "Other";
}
