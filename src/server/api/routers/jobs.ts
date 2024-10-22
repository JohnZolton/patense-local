import { log } from "console";
import {
  JsonSchema7AllOfType,
  JsonSchema7Type,
  zodToJsonSchema,
} from "zod-to-json-schema";
import { APIPromise } from "openai/core.mjs";
import { z } from "zod";
import EventEmitter from "events";
import { observable } from "@trpc/server/observable";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { InventiveFeature, PrismaClient } from "@prisma/client";
import { extendTailwindMerge } from "tailwind-merge";
import { zodResponseFormat } from "openai/helpers/zod";
import fs from "fs";
import path from "path";

const extractionEmitter = new EventEmitter();
const extractionUpdateSchema = z.object({
  id: z.number(),
  jobId: z.number(),
  feature: z.string(),
  context: z.string(),
  completed: z.boolean(),
  createdAt: z.date(),
});

type ExtractionUpdate = z.infer<typeof extractionUpdateSchema>;

interface Page {
  id: number;
  refId: number;
  pageNum: number;
  content: string;
}

interface Reference {
  id: number;
  title: string;
  pages: Page[];
}

interface References {
  references: Reference[];
}

export const jobRouter = createTRPCRouter({
  getAllJobs: publicProcedure.query(({ ctx }) => {
    return ctx.db.job.findMany({
      orderBy: { createdAt: "asc" },
    });
  }),

  deleteJob: publicProcedure
    .input(
      z.object({
        jobId: z.number(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const jobId = input.jobId;
      return ctx.db.job.delete({
        where: { id: jobId },
      });
    }),
  getJob: publicProcedure
    .input(
      z.object({
        jobId: z.string(),
      }),
    )
    .query(({ ctx, input }) => {
      const jobId = parseInt(input.jobId, 10);
      return ctx.db.job.findFirst({
        where: { id: jobId },
        include: {
          references: {
            include: {
              pages: true,
            },
          },
          features: {
            include: { analysis: true },
          },
          inventiveFeatureJobs: {
            include: {
              inventiveFeatures: true,
            },
          },
        },
      });
    }),

  startExtraction: publicProcedure
    .input(
      z.object({
        jobId: z.string(),
        references: z.array(
          z.object({
            id: z.number(),
            title: z.string(),
            pages: z.array(
              z.object({
                id: z.number(),
                refId: z.number(),
                pageNum: z.number(),
                content: z.string(),
              }),
            ),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const jobId = parseInt(input.jobId, 10);
      const job = await ctx.db.inventiveFeatureJob.create({
        data: { jobId, completed: false },
      });

      // Start the extraction process asynchronously
      void extractFeatures(job.id, ctx.db, input.references);

      return { jobId: job.id };
    }),

  getExtractionUpdates: publicProcedure
    .input(
      z.object({
        jobId: z.number(),
      }),
    )
    .query(({ ctx, input }) => {
      return ctx.db.inventiveFeatureJob.findFirst({
        where: {
          jobId: input.jobId,
        },
        include: {
          inventiveFeatures: true,
        },
      });
    }),

  deepSearch: publicProcedure
    .input(
      z.object({
        jobId: z.string(),
        feature: z.string(),
        references: z.array(
          z.object({
            id: z.number(),
            title: z.string(),
            pages: z.array(
              z.object({
                id: z.number(),
                refId: z.number(),
                pageNum: z.number(),
                content: z.string(),
              }),
            ),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      console.log(input.feature);
      const feature = await ctx.db.feature.create({
        data: {
          feature: input.feature,
          jobId: parseInt(input.jobId, 10),
        },
      });

      console.time("total time");
      const requests: {
        request: APIPromise<OpenAI.Chat.Completions.ChatCompletion>;
        page: {
          id: number;
          refId: number;
          pageNum: number;
          content: string;
        };
      }[] = [];
      for (const ref of input.references) {
        for (const page of ref.pages) {
          const systemPrompt = `You are a document analyst. Analyze whether the following text is relevant to a given user query. Be conservative, if something is borderline, answer yes. you are flagging text for manual review.
            INSTRUCTIONS: return an answer, yes or no, in <answer></answer> tags.
            If the answer is yes, also include a short quote in <quote></quote> tags`;

          const userPrompt = `
          -------------------------------------
          TEXT: ${page.content}
          -------------------------------------
          QUERY: ${input.feature}
          -------------------------------------
          Is the above text relevant to the query? 
          `;

          const request = vLLMClient.chat.completions.create({
            model: "NousResearch/Meta-Llama-3.1-8B-Instruct",
            //model: "hugging-quants/Meta-Llama-3.1-8B-Instruct-AWQ-INT4",
            //model: "turboderp_Llama-3.1-8B-Instruct-exl2_8.0bpw",
            messages: [
              { role: "system", content: systemPrompt },
              {
                role: "user",
                content: userPrompt,
              },
            ],
          });

          requests.push({ request, page });
        }
        const responses = await Promise.all(
          requests.map((item) => item.request),
        );

        await Promise.all(
          responses.map(async (response, index) => {
            const page = requests[index]?.page;
            const pageAnalysis =
              response.choices[0]?.message.content ?? "error";
            let answer = "";
            const answerRegex = /<answer>(.*?)<\/answer>/s;
            const answerMatch = answerRegex.exec(pageAnalysis);
            answer = answerMatch?.[1]?.trim() ?? "";
            let quote = "";
            const quoteRegex = /<quote>(.*?)<\/quote>/s;
            const quoteMatch = quoteRegex.exec(pageAnalysis);
            quote = quoteMatch?.[1]?.trim() ?? "";

            if (answer.toLowerCase() === "yes") {
              await ctx.db.analysis.create({
                data: {
                  featureId: feature.id,
                  conclusion: answer,
                  quote: quote,
                  refPage: page?.pageNum ?? 0,
                  refContent: page?.content ?? "err",
                  refId: ref.id,
                  refTitle: ref.title,
                },
              });
            }
            return 1;
          }),
        );
        console.log(`analyzed ${responses.length} pages in:`);
        console.timeEnd("total time");
        await ctx.db.feature.update({
          where: {
            id: feature.id,
          },
          data: {
            completed: true,
          },
        });
        return ctx.db.job.findFirst({
          where: { id: parseInt(input.jobId, 10) },
          include: {
            references: {
              include: {
                pages: true,
              },
            },
            features: {
              include: { analysis: true },
            },
          },
        });
      }
    }),

  createJob: publicProcedure
    .input(
      z.object({
        references: z.array(
          z.object({
            title: z.string(),
            pages: z.array(
              z.object({
                pageNum: z.number(),
                content: z.string(),
              }),
            ),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.job.create({
        data: {
          references: {
            create: input.references.map((ref) => ({
              title: ref.title,
              pages: {
                create: ref.pages.map((page) => ({
                  pageNum: page.pageNum,
                  content: page.content,
                })),
              },
            })),
          },
        },
        include: {
          references: {
            include: {
              pages: true,
            },
          },
        },
      });
    }),

  testVLLM: publicProcedure
    .input(
      z.object({
        spec: z
          .object({
            title: z.string(),
            pages: z.array(
              z.object({
                pageNum: z.number(),
                content: z.string(),
              }),
            ),
          })
          .optional(),
        claims: z
          .object({
            title: z.string(),
            pages: z.array(
              z.object({
                pageNum: z.number(),
                content: z.string(),
              }),
            ),
          })
          .optional(),
        officeAction: z
          .object({
            title: z.string(),
            pages: z.array(
              z.object({
                pageNum: z.number(),
                content: z.string(),
              }),
            ),
          })
          .optional(),
        references: z
          .array(
            z.object({
              title: z.string(),
              pages: z.array(
                z.object({
                  pageNum: z.number(),
                  content: z.string(),
                }),
              ),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // flow:
      // grab all claims
      // split to elements
      // add examiner rejection reason + citation
      // 1) confirm examiner rejections || distinguish
      //    1.1) get claims -> elements
      //    1.2) search references
      // 2) find valid amendments

      console.time("totaltest");
      if (input.references) {
        /*
        const claimJson = await parseClaimsToJson(input.claims);
        console.log(claimJson);
        claimJson.forEach((item) => {
          console.log(item.claim);
          console.log(item.elements);
        });
        saveClaimJsonToFile(claimJson);
        */
        const claimJson = loadClaimJsonFromFile();
        //const features = await extractFeaturesJson(page.content);

        //search refs for features
        //make comparison promises, probs some early returning
        if (!claimJson) {
          return;
        }
        const claimItems: ClaimItem[] = claimJson;
        console.log(claimItems);

        const stats = {
          totalProcessed: 0,
          earlyReturns: 0,
          apiCalls: 0,
        };
        const BATCH_SIZE_LIMIT = 30;
        const RATE_LIMIT_DELAY = 3000;
        const claimPromises: Array<
          () => Promise<
            | {
                success: boolean;
              }
            | undefined
          >
        > = [];
        let CURRENT_CALLS = 0;
        for (const reference of input.references) {
          for (const page of reference.pages) {
            for (const item of claimItems) {
              for (const element of item.elements) {
                if (!element.disclosed) {
                  // Push a function that returns the promise, instead of directly executing it
                  claimPromises.push(() => {
                    return processElement(item, element, page, stats);
                  });
                }
              }
            }
          }
        }
        console.log(claimPromises);
        async function processQueue() {
          const activePromises = [];

          while (claimPromises.length > 0 || activePromises.length > 0) {
            console.log("claim promises: ", claimPromises.length);
            console.log("active promises: ", activePromises.length);
            // Process new tasks if under batch limit
            while (
              CURRENT_CALLS < BATCH_SIZE_LIMIT &&
              claimPromises.length > 0
            ) {
              const task = claimPromises.shift();
              if (task) {
                CURRENT_CALLS++;
                const promise = task().finally(() => {
                  CURRENT_CALLS--;
                });
                activePromises.push(promise);
              }
            }

            // Wait for at least one promise to complete
            if (activePromises.length > 0) {
              try {
                await Promise.race(activePromises);
                const settled = await Promise.allSettled(activePromises);
                activePromises.length = 0;
              } catch (error) {
                console.error("Promise failed:", error);
              }
            }

            if (activePromises.length === 0 && claimPromises.length === 0) {
              break;
            }

            // Rate limiting delay
            await new Promise((resolve) =>
              setTimeout(resolve, RATE_LIMIT_DELAY),
            );
          }
        }
        await processQueue();
        console.log("queue completed");
        claimItems.forEach((item) =>
          item.elements.forEach((element) => console.log(element)),
        );
        console.log("total calls: ", stats.apiCalls);
        console.timeEnd("totaltest");
      }
    }),
});

interface ClaimItem {
  claim: string;
  elements: Element[];
}
interface Element {
  element: string;
  disclosed?: boolean;
  quote?: string;
  cite?: string;
}
interface Stats {
  totalProcessed: number;
  earlyReturns: number;
  apiCalls: number;
}
interface DbPage {
  pageNum: number;
  content: string;
}
async function processElement(
  item: ClaimItem,
  element: Element,
  page: DbPage,
  stats: Stats,
) {
  try {
    stats.apiCalls++;
    if (element.disclosed) {
      console.log("DISCLOSED, RETURNING EARLY");
      return;
    }
    const responseFormat = z.object({
      disclosed: z.boolean(),
      quote: z.string(),
    });

    const answerFormatSchema = zodToJsonSchema(responseFormat, "AnswerFormat");
    const sysPrompt = `You are an amazing, sentient patent analysis AI. You determine whether an inventive element is disclosed by a reference, answer true/false, and give a quote.`;
    const userPrompt = `is this element: ${element.element}\n\ndislcosed by this page: ${page.content}`;
    const llmResponse = await createLlmCallForceJson(
      answerFormatSchema,
      sysPrompt,
      userPrompt,
    );
    const structuredData = llmResponse.choices[0]?.message?.content ?? "error";
    if (structuredData.disclosed) {
      element.disclosed = true;
      element.quote = structuredData.quote;
    }
    stats.totalProcessed++;
    console.log("response: ", structuredData);
    return { success: true };
  } catch (error) {
    console.error(`Error processing element: ${element.element}`, error);
  }
}

async function saveClaimJsonToFile(claimJson: ClaimItem[]) {
  const filePath = path.join(process.cwd(), "claimData.json");
  fs.writeFileSync(filePath, JSON.stringify(claimJson, null, 2), "utf-8");
  console.log(`claimJson written to ${path}`);
}

interface JsonLoadsData {}
function loadClaimJsonFromFile() {
  const filePath = path.join(process.cwd(), "claimData.json");
  if (fs.existsSync(filePath)) {
    const fileContent = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(fileContent) as ClaimItem[];
  } else {
    console.error("file not found");
    return null;
  }
}

async function createLlmCallForceJson(
  formatSchema: JsonSchema7Type & {
    $schema?: string | undefined;
    definitions?:
      | {
          [key: string]: JsonSchema7Type;
        }
      | undefined;
  },
  sysPrompt: string,
  userPrompt: string,
) {
  const request = await fetch("http://0.0.0.0:8000/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "NousResearch/Meta-Llama-3.1-8B-Instruct",
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user", content: userPrompt },
      ],
      guided_json: formatSchema,
    }),
  }).then((response) => response.json());
  return request;
}

async function parseClaimsToJson(claims: {
  title: string;
  pages: {
    pageNum: number;
    content: string;
  }[];
}) {
  const fullText = claims.pages.map((item) => item.content).join("");
  const claimList = fullText.split("\n\n\n\n");
  const claimElementPromises = claimList.map((claim) =>
    extractClaimElementsJson(claim),
  );
  return await Promise.all(claimElementPromises);
}
async function extractClaimElementsJson(claim: string) {
  const featureResponse = z.object({
    elements: z.array(z.string()),
  });

  const answerFormatSchema = zodToJsonSchema(featureResponse, "AnswerFormat");
  const requestsJson: {
    request: Promise<any>; // Adjust the type if you know the exact response type.
    page: {
      pageNum: number;
      content: string;
    };
  }[] = [];
  const systemPromptJson = `You are a stellar patent analyst AI. 
          INSTRUCTIONS: intake a claim and break it down into individual elements or ideas that make sense. return the answer in JSON {elements: string[]}`;

  const userPromptJson = `
          -------------------------------------
          CLAIM: ${claim}
          -------------------------------------
          extract the elements from the above claim.
        `;

  const request = createLlmCallForceJson(
    answerFormatSchema,
    systemPromptJson,
    userPromptJson,
  );

  requestsJson.push({
    request,
    page: { pageNum: 1, content: claim },
  });
  const responsesJson = await Promise.all(
    requestsJson.map((item) => item.request),
  );
  const result = responsesJson.map((response, index) => {
    const page = requestsJson[index]?.page;
    const structuredData = response.choices[0]?.message?.content ?? "error";

    return JSON.parse(structuredData);
  });
  console.log(result);
  return { claim, elements: result[0].elements };
}
async function extractFeaturesJson(pageContent: string) {
  const paragraphs = splitIntoParagraphs(pageContent);
  const Feature = z.object({
    description: z.string(),
  });

  const FeaturesResponse = z.object({
    features: z.array(Feature),
  });

  const answerFormatSchema = zodToJsonSchema(FeaturesResponse, "AnswerFormat");
  const requestsJson: {
    request: Promise<any>; // Adjust the type if you know the exact response type.
    page: {
      pageNum: number;
      content: string;
    };
  }[] = [];
  for (const paragraph of paragraphs) {
    const systemPromptJson = `You are a stellar patent analyst AI. 
          INSTRUCTIONS: intake a section of the Specification and extract every inventive feature and return it in JSON: features: {description:string}[]`;

    const userPromptJson = `
          -------------------------------------
          TEXT: ${paragraph}
          -------------------------------------
          extract every inventive feature from the above disclosure and return in phrasing fragments suitable for dependent claims, do not include the prelude.
        `;

    const request = createLlmCallForceJson(
      answerFormatSchema,
      systemPromptJson,
      userPromptJson,
    );

    requestsJson.push({
      request,
      page: { pageNum: 1, content: paragraph },
    });
  }
  const responsesJson = await Promise.all(
    requestsJson.map((item) => item.request),
  );
  const result = responsesJson.map((response, index) => {
    const page = requestsJson[index]?.page;
    const structuredData = response.choices[0]?.message?.content ?? "error";

    return JSON.parse(structuredData);
  });
  return result;
}

import OpenAI from "openai";

const vLLMClient = new OpenAI({
  apiKey: "8d1c17826b640774e7c0da1fca3c7830",
  baseURL: "http://0.0.0.0:8000/v1",
  //baseURL: "http://0.0.0.0:5000/v1",
});

interface Page {
  id: number;
  refId: number;
  pageNum: number;
  content: string;
}
function splitIntoParagraphs(page: string) {
  return page.split(/\n/).filter((para) => para.trim() !== "");
}
async function extractFeatures(
  jobId: number,
  prisma: PrismaClient,
  references: (Reference & { pages: Page[] })[],
) {
  const requests: {
    request: APIPromise<OpenAI.Chat.Completions.ChatCompletion>;
    page: {
      id: number;
      refId: number;
      pageNum: number;
      content: string;
    };
  }[] = [];
  console.time("extraction-time");

  for (const ref of references) {
    for (const page of ref.pages) {
      const paragraphs = splitIntoParagraphs(page.content);
      for (const paragraph of paragraphs) {
        const systemPrompt = `You are an expert patent analyst. 
            INSTRUCTIONS: identify every inventive feature in the disclosure, return each feature in <feature></feature> tags.`;

        const userPrompt = `
          -------------------------------------
          TEXT: ${paragraph}
          -------------------------------------
          extract every inventive feature from the above disclosure. return features in fragments suitable for dependent claims.
          `;

        const request = vLLMClient.chat.completions.create({
          model: "NousResearch/Meta-Llama-3.1-8B-Instruct",

          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: userPrompt,
            },
          ],
        });
        requests.push({ request, page });
      }
    }
  }
  const responses = await Promise.all(requests.map((item) => item.request));
  await Promise.all(
    responses.map(async (response, index) => {
      const page = requests[index]?.page;
      const pageAnalysis = response.choices[0]?.message.content ?? "error";
      const featureRegex = /<feature>(.*?)<\/feature>/gs;
      const features = pageAnalysis.match(featureRegex);

      if (features) {
        for (const feature of features) {
          const cleanFeature = feature.replace(/<\/?feature>/g, "").trim();
          await prisma.inventiveFeature.create({
            data: {
              jobId: jobId,
              feature: cleanFeature,
              context: page?.content ?? "error",
            },
          });
        }
      }
    }),
  );
  await prisma.inventiveFeatureJob.update({
    where: { id: jobId },
    data: {
      completed: true,
    },
  });
  const totalPages = references
    .map((ref) => ref.pages.length)
    .reduce((acc, pages) => acc + pages, 0);
  console.log("pages analyzed: ", totalPages);
  console.timeEnd("extraction-time");
}
