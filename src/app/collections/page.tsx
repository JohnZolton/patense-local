"use client";
import Link from "next/link";
import { buttonVariants } from "~/components/ui/button";
import { api } from "~/trpc/react";
import { LoadingSpinner } from "../_components/loader";
import { Suspense } from "react";

export default function Dashboard() {
  const { data: allJobs, isLoading } = api.job.getAllJobs.useQuery();

  return (
    <main className="flex min-h-screen flex-col items-center justify-start">
      <div className="container flex flex-col items-center justify-center px-4">
        <h1 className="pb-4 text-4xl font-extrabold tracking-tight">
          All Analyses
        </h1>
        {isLoading && (
          <div className="my-8">
            <LoadingSpinner />
          </div>
        )}

        {allJobs &&
          allJobs.map((job, index) => (
            <div key={index}>
              <Link
                className={buttonVariants({ variant: "ghost" })}
                href={`/collections/${job.id}`}
              >
                Job {job.id} - {job.createdAt.toLocaleDateString()}
              </Link>
            </div>
          ))}
      </div>
    </main>
  );
}
