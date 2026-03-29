import { z } from "zod";

/** Digicon combined roll max lengths (guide: important rules). */
export const DIGICON_MAX_TO_DIGITAL_CUTTER_M = 1200;
export const DIGICON_MAX_TO_SLITTER_M = 1700;

export const jobSwitchSchema = z
  .object({
    pdfQty: z.coerce.number().int().positive(),
    /** Substrate / product material (not the PDF file name). Stored as `substrate_printcolour` with `printColour`. */
    material: z.string().min(1),
    printColour: z.string().min(1),
    /** PDF or submission file name when applicable. */
    fileName: z.string().min(1).optional().nullable(),
    finishing: z.enum(["none", "matte_varnish", "gloss_varnish", "laminate_adhesive"]),
    productionPath: z.enum([
      "indigo_only",
      "digicon",
      "digital_cutter",
      "slitter",
    ]),
    rollQty: z.coerce.number().int().positive().optional().nullable(),
    rollDirection: z.enum(["unwind_left", "unwind_right"]).optional().nullable(),
    coreSizes: z.array(z.string()).optional(),
    dueDate: z.string().optional().nullable(),
    labelWidthMm: z.coerce.number().positive().optional().nullable(),
    labelHeightMm: z.coerce.number().positive().optional().nullable(),
    labelGapMm: z.coerce.number().nonnegative().optional().nullable(),
    labelsAcross: z.coerce.number().int().min(1).max(10).optional().nullable(),
    rollLengthMetres: z.coerce.number().positive().optional().nullable(),
    overlaminateFilm: z
      .enum(["gloss", "matte", "glitter", "rough_touch"])
      .optional()
      .nullable(),
    forClient: z.boolean().optional().nullable(),

    /** Switch `Copies`; when set, estimator may prefer this over pdfQty. */
    copies: z.coerce.number().int().positive().optional().nullable(),
    /** DieMetadata.AcrossNumber / DieNumberDigital. */
    dieNumberDigital: z.coerce.number().int().positive().optional().nullable(),
    /** Semi-rotary PlateHeight (mm). */
    plateHeightMm: z.coerce.number().positive().optional().nullable(),
    /** DieMetadata + job vars bundle (AcrossNumber, AroundNumber, dimensions, gaps, material, finishing, etc.). */
    switchDieInput: z.record(z.unknown()).optional().nullable(),
    /** time_v1_sscript output private data (ProductionEst*, breakdowns, status). */
    switchEstimateOutput: z.record(z.unknown()).optional().nullable(),
    timeEstimationStatus: z
      .enum(["SUCCESS", "ERROR", "ERROR_MISSING_PARAMETERS"])
      .optional()
      .nullable(),
    timeEstimationError: z.string().optional().nullable(),
    timeEstimationAt: z.string().datetime().optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.productionPath !== "digicon") return;
    const len = data.rollLengthMetres;
    if (len == null) return;
    if (len > DIGICON_MAX_TO_SLITTER_M) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Digicon combined roll: length must be ≤ ${DIGICON_MAX_TO_SLITTER_M}m (Slitter leg); ≤ ${DIGICON_MAX_TO_DIGITAL_CUTTER_M}m to Digital Cutter`,
        path: ["rollLengthMetres"],
      });
    }
  });

export type JobSwitchInput = z.infer<typeof jobSwitchSchema>;
