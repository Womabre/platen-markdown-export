// ── Document-language labels ─────────────────────────────────────────────────
//
// Every piece of text the exporter itself writes into a document, per `Lang`.
// One table, so a new language or a new label is added in one place rather than
// in a table per module that each fall out of step with the others.

export interface DocumentLabels {
    /** Glossary section heading and its two column headers. */
    glossaryHeading: string;
    glossaryAbbr:    string;
    glossaryDef:     string;
    /** Caption prefixes, rendered as "<table> 1." / "<figure> 1.". */
    table:  string;
    figure: string;
    /** Headings of the optional caption indexes. */
    listOfTables:  string;
    listOfFigures: string;
}

const LABELS: Record<string, DocumentLabels> = {
    en: {
        glossaryHeading: 'Abbreviations', glossaryAbbr: 'Abbreviation', glossaryDef: 'Description',
        table: 'Table', figure: 'Figure',
        listOfTables: 'List of Tables', listOfFigures: 'List of Figures',
    },
    nl: {
        glossaryHeading: 'Afkortingen', glossaryAbbr: 'Afkorting', glossaryDef: 'Omschrijving',
        table: 'Tabel', figure: 'Figuur',
        listOfTables: 'Lijst van tabellen', listOfFigures: 'Lijst van figuren',
    },
    de: {
        glossaryHeading: 'Abkürzungen', glossaryAbbr: 'Abkürzung', glossaryDef: 'Beschreibung',
        table: 'Tabelle', figure: 'Abbildung',
        listOfTables: 'Tabellenverzeichnis', listOfFigures: 'Abbildungsverzeichnis',
    },
    fr: {
        glossaryHeading: 'Abréviations', glossaryAbbr: 'Abréviation', glossaryDef: 'Description',
        table: 'Tableau', figure: 'Figure',
        listOfTables: 'Liste des tableaux', listOfFigures: 'Liste des figures',
    },
    es: {
        glossaryHeading: 'Abreviaturas', glossaryAbbr: 'Abreviatura', glossaryDef: 'Descripción',
        table: 'Tabla', figure: 'Figura',
        listOfTables: 'Índice de tablas', listOfFigures: 'Índice de figuras',
    },
};

/**
 * The labels for a `Lang` value, falling back to English. Only the primary
 * language subtag counts, so `nl-NL` and `nl_BE` get the Dutch labels rather
 * than silently falling through to English.
 */
export function documentLabels(lang: string | null | undefined): DocumentLabels {
    const primary = (lang ?? '').trim().toLowerCase().split(/[-_]/)[0];
    return LABELS[primary] ?? LABELS.en;
}
