"use client";
import { useRouter } from "next/navigation";
import {
  PDFDocumentProxy,
  TextItem,
  TextMarkedContent,
} from "pdfjs-dist/types/src/display/api";
import Link from "next/link";
import { api } from "~/trpc/react";
import Dropzone from "react-dropzone";
import { useCallback, useEffect, useState } from "react";
import { Cloud, Delete } from "lucide-react";
import { Button } from "~/components/ui/button";
import { pdfjs } from "react-pdf";
import { LoadingSpinner } from "../_components/loader";
//import "pdfjs-dist/webpack";
import mammoth from "mammoth";

interface UploadedDocument {
  title: string;
  pages: { pageNum: number; content: string }[];
}

enum FileType {
  spec,
  claims,
  oa,
  references,
}
export default function Page() {
  const onDrop = useCallback((acceptedFiles: File[], fileType: FileType) => {
    switch (fileType) {
      case FileType.spec:
        setSpec(acceptedFiles[0]);
        break;
      case FileType.claims:
        setClaims(acceptedFiles[0]);
        break;
      case FileType.oa:
        setOfficeAction(acceptedFiles[0]);
        break;
      case FileType.references:
        setReferences((prev) => [...prev, ...acceptedFiles]);
        break;
    }
  }, []);

  useEffect(() => {
    pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
  }, []);

  const [specFile, setSpec] = useState<File>();
  const [claimFile, setClaims] = useState<File>();
  const [officeActionFile, setOfficeAction] = useState<File>();
  const [referenceFiles, setReferences] = useState<File[]>([]);

  const [specFileText, setSpecFileText] = useState<
    UploadedDocument | undefined
  >(undefined);
  const [claimFileText, setClaimFileText] = useState<
    UploadedDocument | undefined
  >(undefined);
  const [officeActionText, setOfficeActionText] = useState<
    UploadedDocument | undefined
  >(undefined);
  const [referenceTexts, setReferenceTexts] = useState<UploadedDocument[]>([]);

  async function extractText(pdf: PDFDocumentProxy) {
    function isTextItem(item: TextItem | TextMarkedContent): item is TextItem {
      return "str" in item;
    }

    let fullText = "";
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .filter(isTextItem)
        .map((item) => item.str)
        .join(" ");
      fullText += pageText + "\n";
      pages.push({ content: pageText, pageNum: i });
    }
    return pages;
  }

  async function extractTextFromDOCX(file: File) {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    const text = result.value;
    return [{ content: text, pageNum: 1 }];
  }

  async function processFile(file: File) {
    let pages;
    if (file.name.endsWith(".pdf")) {
      const pdf = await pdfjs.getDocument(await file.arrayBuffer()).promise;
      pages = await extractText(pdf as unknown as PDFDocumentProxy);
    } else if (file.name.endsWith(".docx")) {
      pages = await extractTextFromDOCX(file);
    } else {
      throw new Error("unsupported file type");
    }
    return { title: file.name, pages: pages };
  }

  useEffect(() => {
    async function processFiles() {
      try {
        const refs = await Promise.all(
          referenceFiles.map(async (file) => await processFile(file)),
        );
        setReferenceTexts(refs);

        // Process specific files
        if (specFile) {
          const specPages = await processFile(specFile);
          console.log(specPages);
          setSpecFileText(specPages);
        }

        if (claimFile) {
          const claimPages = await processFile(claimFile);
          setClaimFileText(claimPages);
        }

        if (officeActionFile) {
          const officeActionPages = await processFile(officeActionFile);
          setOfficeActionText(officeActionPages);
        }
      } catch (error) {
        console.error(error);
      }
    }
    void processFiles();
  }, [specFile, claimFile, officeActionFile, referenceFiles]);

  useEffect(() => {
    console.log(specFileText);
    console.log(claimFileText);
    console.log(officeActionText);
    console.log(referenceTexts);
  }, [specFileText, claimFileText, officeActionText, referenceTexts]);

  const { mutate: testVLLm } = api.job.testVLLM.useMutation();

  function handleTestButton() {
    testVLLm({
      spec: specFileText,
      claims: claimFileText,
      references: referenceTexts,
      officeAction: officeActionText,
    });
  }

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-start">
      <div className="container mt-2 flex w-full flex-col items-center gap-y-2 px-4">
        <h1 className="text-3xl font-extrabold tracking-tight">
          NEW OFFICE ACTION
        </h1>
        {specFile ? (
          <div className="flex flex-row items-center justify-between gap-x-8">
            <div>{specFile.name}</div>
            <Button onClick={() => setSpec(undefined)}>X</Button>
          </div>
        ) : (
          <FileDropZone dropType={FileType.spec} onDrop={onDrop} />
        )}
        {claimFile ? (
          <div className="flex flex-row items-center justify-between gap-x-8">
            <div>{claimFile.name}</div>
            <Button onClick={() => setClaims(undefined)}>X</Button>
          </div>
        ) : (
          <FileDropZone dropType={FileType.claims} onDrop={onDrop} />
        )}
        {officeActionFile ? (
          <div className="flex flex-row items-center justify-between gap-x-8">
            <div>{officeActionFile.name}</div>
            <Button onClick={() => setOfficeAction(undefined)}>X</Button>
          </div>
        ) : (
          <FileDropZone dropType={FileType.oa} onDrop={onDrop} />
        )}
        <FileDropZone dropType={FileType.references} onDrop={onDrop} />
        {referenceFiles.length > 0 && (
          <>
            {referenceFiles.map((ref, index) => (
              <div
                key={index}
                className="flex flex-row items-center justify-between gap-x-8"
              >
                <div>{ref.name}</div>
                <Button
                  variant={"destructive"}
                  onClick={() =>
                    setReferences((prev) => prev.filter((_, i) => i !== index))
                  }
                >
                  X
                </Button>
              </div>
            ))}
          </>
        )}
      </div>
      <Button className="m-2" onClick={handleTestButton}>
        test structured output
      </Button>
    </div>
  );
}

interface FileDropZoneProps {
  onDrop: (acceptedFiles: File[], fileType: FileType) => void;
  dropType: FileType;
}
function FileDropZone({ onDrop, dropType }: FileDropZoneProps) {
  const label = () => {
    switch (dropType) {
      case FileType.spec:
        return "Specification";
      case FileType.claims:
        return "Claims";
      case FileType.oa:
        return "Office Action";
      case FileType.references:
        return "References";
      default:
        return "";
    }
  };
  return (
    <Dropzone
      multiple={true}
      accept={{
        "application/pdf": [".pdf"],
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
          [".docx"],
      }}
      onDrop={(acceptedFiles) => {
        if (acceptedFiles.length > 0 && acceptedFiles[0] !== undefined) {
          onDrop(acceptedFiles, dropType);
        }
      }}
    >
      {({ getRootProps, getInputProps, acceptedFiles }) => (
        <div className="h-24 w-1/2 rounded-[var(--radius)] border border-dashed border-[hsl(var(--foreground))] bg-[hsl(var(--background))] text-[hsl(var(--foreground))] hover:bg-[hsl(var(--border))]">
          <div
            {...getRootProps()}
            className="flex h-full w-full items-center justify-center"
          >
            <label
              htmlFor="dropzone-file"
              className="flex h-full w-full cursor-pointer flex-col items-center justify-center rounded-[var(--radius)] hover:bg-[hsl(var(--accent))/0.25]"
            >
              <div className="flex flex-col items-center justify-center pt-2 text-[hsl(var(--foreground))]">
                {label()}
              </div>
              <div className="text-[hsl(var(--foreground))]">
                <Cloud className="h-8 w-8" />
              </div>
              <p className="mb-2 text-sm">
                <span className="font-semibold">Click to upload</span> or drag
                and drop
              </p>
              <input
                {...getInputProps()}
                type="file"
                id="dropzone-file"
                className="hidden"
              />
            </label>
          </div>
        </div>
      )}
    </Dropzone>
  );
}
