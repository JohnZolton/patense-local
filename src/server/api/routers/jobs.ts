import { log } from "console";
import { APIPromise } from "openai/core.mjs";
import { z } from "zod";
import EventEmitter from "events";
import { observable } from "@trpc/server/observable";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { InventiveFeature, PrismaClient } from "@prisma/client";
import { extendTailwindMerge } from "tailwind-merge";

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

  testVLLM: publicProcedure.mutation(async ({ ctx }) => {
    console.time("total time");
    const requests = [];
    for (let i = 0; i < 100; i++) {
      const request = vLLMClient.chat.completions.create({
        model: "NousResearch/Meta-Llama-3.1-8B-Instruct",

        messages: [
          { role: "system", content: "You are a helpful assistant." },
          {
            role: "user",
            content: "Write a haiku about recursion in programming.",
          },
        ],
      });

      requests.push(request);
    }
    const responses = await Promise.all(requests);
    responses.forEach((response, index) => {
      console.log(`${index}:${response.choices[0]?.message.content}`);
    });
    console.timeEnd("total time");
  }),
});

import OpenAI from "openai";

const vLLMClient = new OpenAI({
  apiKey: "fake",
  baseURL: "http://0.0.0.0:8000/v1",
});

interface Page {
  id: number;
  refId: number;
  pageNum: number;
  content: string;
}
async function extractFeatures(
  jobId: number,
  prisma: PrismaClient,
  references: (Reference & { pages: Page[] })[],
) {
  interface Page {
    id: number;
    refId: number;
    pageNum: number;
    content: string;
  }
  function splitIntoParagraphs(page: Page) {
    return page.content.split(/\n/).filter((para) => para.trim() !== "");
  }
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
      const paragraphs = splitIntoParagraphs(page);
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
