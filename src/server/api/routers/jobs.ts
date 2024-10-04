import { log } from "console";
import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

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
          inventiveFeatures: true,
        },
      });
    }),

  extractAllFeatures: publicProcedure
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
      const webUiEndpoint = "http://127.0.0.1:5000/v1/chat/completions";
      async function getCompletion(message: string) {
        const response = await fetch(webUiEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages: [
              {
                role: "user",
                content: message,
              },
            ],
          }),
        });
        interface ApiResponse {
          choices: Array<{
            message: {
              content: string;
            };
          }>;
        }
        const content = (await response.json()) as ApiResponse;
        console.log(content);
        if (content && content.choices.length > 0) {
          return content.choices[0]!.message.content;
        }
        return "zzz";
      }

      interface Page {
        id: number;
        refId: number;
        pageNum: number;
        content: string;
      }
      function splitIntoParagraphs(page: Page) {
        return page.content
          .split(/\n\s*\n/)
          .filter((para) => para.trim() !== "");
      }

      for (const ref of input.references) {
        for (const page of ref.pages) {
          const paragraphs = splitIntoParagraphs(page);
          for (const paragraph of paragraphs) {
            console.log(paragraph);
            const message = `You are an expert patent analyst. 
            INSTRUCTIONS: identify every inventive feature in the disclosure, return each feature in <feature></feature> tags.
            ----------------------------------
          DISCLOSURE: ${paragraph}
          -------------------------------------
            extract every inventive feature from the above disclosure. return features in fragments suitable for dependent claims.
          `;
            const pageAnalysis = await getCompletion(message);
            const featureRegex = /<feature>(.*?)<\/feature>/gs;
            const features = pageAnalysis.match(featureRegex);
            const results = [];
            console.log(features);

            if (features) {
              for (const feature of features) {
                const cleanFeature = feature
                  .replace(/<\/?feature>/g, "")
                  .trim();
                console.log(cleanFeature);
                const extractedFeatures = await ctx.db.inventiveFeature.create({
                  data: {
                    jobId: parseInt(input.jobId, 10),
                    feature: cleanFeature,
                    context: page.content,
                  },
                });
                results.push(extractedFeatures);
              }
            }
          }
        }
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
            inventiveFeatures: true,
          },
        });
      }
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
      const webUiEndpoint = "http://127.0.0.1:5000/v1/chat/completions";
      async function getCompletion(message: string) {
        const response = await fetch(webUiEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages: [
              {
                role: "user",
                content: message,
              },
            ],
          }),
        });
        interface ApiResponse {
          choices: Array<{
            message: {
              content: string;
            };
          }>;
        }
        const content = (await response.json()) as ApiResponse;
        console.log(content);
        if (content && content.choices.length > 0) {
          return content.choices[0]!.message.content;
        }
        return "zzz";
      }

      const feature = await ctx.db.feature.create({
        data: {
          feature: input.feature,
          jobId: parseInt(input.jobId, 10),
        },
      });

      const results = [];
      for (const ref of input.references) {
        for (const page of ref.pages) {
          const message = `You are a document analyst. Analyze whether the following text is relevant to a given user query. Be conservative, if something is borderline, answer yes. you are flagging text for manual review.
            INSTRUCTIONS: return an answer, yes or no, in <answer></answer> tags.
            If the answer is yes, also include a short quote in <quote></quote> tags
            -------------------
          TEXT: ${page.content}
          -------------------------------------
          QUERY: ${input.feature}
          -------------------------------------
          Is the above text relevant to the query? 
          `;
          const pageAnalysis = await getCompletion(message);
          let answer = "";
          const answerRegex = /<answer>(.*?)<\/answer>/s;
          const answerMatch = answerRegex.exec(pageAnalysis);
          answer = answerMatch?.[1]?.trim() ?? "";
          let quote = "";
          const quoteRegex = /<quote>(.*?)<\/quote>/s;
          const quoteMatch = quoteRegex.exec(pageAnalysis);
          quote = quoteMatch?.[1]?.trim() ?? "";

          if (answer.toLowerCase() === "yes") {
            const loggedAnalysis = await ctx.db.analysis.create({
              data: {
                featureId: feature.id,
                conclusion: answer,
                quote: quote,
                refPage: page.pageNum,
                refContent: page.content,
                refId: ref.id,
                refTitle: ref.title,
              },
            });
            results.push(loggedAnalysis);
          }
        }
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
});
