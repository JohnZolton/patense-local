"use client";
import { useAutoAnimate } from "@formkit/auto-animate/react";
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
import { Ban, Check, Cloud, Delete, Plus, Trash, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { pdfjs } from "react-pdf";
import { LoadingSpinner } from "../_components/loader";
//import "pdfjs-dist/webpack";
import mammoth from "mammoth";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader } from "~/components/ui/dialog";
import { DialogTitle } from "~/components/ui/dialog";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "~/components/ui/hover-card";

interface UploadedDocument {
  title: string;
  pages: { pageNum: number; content: string }[];
}

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

  const { mutate: searchRefs } = api.job.searchRefsForElements.useMutation({
    onSuccess: (data) => {
      if (data) {
        setClaimItems(data);
      }
    },
  });
  const { mutate: extractClaims } = api.job.extractClaims.useMutation({
    onSuccess: (data) => {
      if (data) {
        setClaimItems(data);
      }
    },
  });
  const { mutate: extractSpecFeatures } =
    api.job.extractSpecFeatures.useMutation();
  const [claimItems, setClaimItems] = useState<ClaimItem[]>();

  function handleExtractClaims() {
    if (claimFileText) {
      extractClaims({ claims: claimFileText });
    }
  }

  const handleElementChange = useCallback(
    (claimIndex: number, elementIndex: number, newValue: string) => {
      setClaimItems((prevItems) => {
        if (!prevItems) return prevItems;
        return prevItems.map((claim, cIdx) =>
          cIdx === claimIndex
            ? {
                ...claim,
                elements: claim.elements.map((element, eIdx) =>
                  eIdx === elementIndex
                    ? { ...element, element: newValue }
                    : element,
                ),
              }
            : claim,
        );
      });
    },
    [setClaimItems],
  );

  useEffect(() => {
    console.log(claimItems);
  }, [claimItems]);

  const addElement = useCallback((claimIndex: number, elementIndex: number) => {
    setClaimItems((prevItems) => {
      if (!prevItems) return prevItems;
      return prevItems.map((claim, idx) =>
        idx === claimIndex
          ? {
              ...claim,
              elements: [
                ...claim.elements.slice(0, elementIndex + 1),
                { element: "" },
                ...claim.elements.slice(elementIndex + 1),
              ],
            }
          : claim,
      );
    });
  }, []);

  const deleteElement = useCallback(
    (claimIndex: number, elementIndex: number) => {
      setClaimItems((prevItems) => {
        if (!prevItems) return prevItems;
        return prevItems.map((claim, idx) =>
          idx === claimIndex
            ? {
                ...claim,
                elements: claim.elements.filter(
                  (_, eIdx) => eIdx !== elementIndex,
                ),
              }
            : claim,
        );
      });
    },
    [],
  );

  function handleSearchRefs() {
    if (claimItems) {
      searchRefs({
        references: referenceTexts,
        claims: claimItems,
      });
    }
  }

  const [parent, enableAnimations] = useAutoAnimate();

  function handleExtractFeatures() {
    if (specFileText) {
      extractSpecFeatures({ spec: specFileText });
    }
  }

  return (
    <div className="flex h-[calc(100vh-120px)] w-full justify-between">
      {/* Sidebar */}
      <div className="w-64 p-4">
        <div className="flex h-full flex-col items-start justify-start gap-y-4">
          <ScrollArea className="h-full w-full pr-3">
            <h2 className="text-lg font-semibold">Documents</h2>

            {/* Specification */}
            <div className="w-full space-y-2">
              <h3 className="font-medium">Specification</h3>
              {specFile ? (
                <div className="flex max-w-full items-center justify-between rounded-l p-2 shadow-sm">
                  <span className="block max-w-[150px] truncate text-sm">
                    {specFile.name}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-2 flex-shrink-0"
                    onClick={() => setSpec(undefined)}
                  >
                    ×
                  </Button>
                </div>
              ) : (
                <FileDropZone dropType={FileType.spec} onDrop={onDrop} />
              )}
            </div>

            {/* Claims */}
            <div className="w-full space-y-2">
              <h3 className="font-medium">Claims</h3>
              {claimFile ? (
                <div className="flex items-center justify-between rounded-lg p-2 shadow-sm">
                  <span className="max-w-[150px] truncate text-sm">
                    {claimFile.name}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setClaims(undefined)}
                  >
                    ×
                  </Button>
                </div>
              ) : (
                <FileDropZone dropType={FileType.claims} onDrop={onDrop} />
              )}
            </div>

            {/* Office Action */}
            <div className="w-full space-y-2">
              <h3 className="font-medium">Office Action</h3>
              {officeActionFile ? (
                <div className="flex items-center justify-between rounded-lg p-2 shadow-sm">
                  <span className="max-w-[150px] truncate text-sm">
                    {officeActionFile.name}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setOfficeAction(undefined)}
                  >
                    ×
                  </Button>
                </div>
              ) : (
                <FileDropZone dropType={FileType.oa} onDrop={onDrop} />
              )}
            </div>

            {/* References */}
            <div className="w-full space-y-2">
              <h3 className="font-medium">References</h3>
              <FileDropZone dropType={FileType.references} onDrop={onDrop} />
              {referenceFiles.length > 0 && (
                <div className="space-y-2">
                  {referenceFiles.map((ref, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between rounded-lg p-2 shadow-sm"
                    >
                      <span className="max-w-[150px] truncate text-sm">
                        {ref.name}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setReferences((prev) =>
                            prev.filter((_, i) => i !== index),
                          )
                        }
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>
          <Button onClick={handleExtractClaims} disabled={!claimFileText}>
            Extract Claims
          </Button>
          <Button
            onClick={handleSearchRefs}
            disabled={!claimItems || referenceFiles.length === 0}
          >
            Search for Elements
          </Button>
        </div>
      </div>

      {/* Main Content Area */}
      <main className="max-w-5xl flex-1 items-center justify-center p-2">
        <h1 className="pb-4 text-center text-3xl font-extrabold tracking-tight">
          NEW OFFICE ACTION
        </h1>
        {/* Main content will go here */}
        <div className="flex flex-row gap-x-4"></div>
        <ScrollArea className="h-full">
          <div className="flex flex-col px-4">
            {claimItems?.map((claim, claimIndex) => (
              <div key={`claim-${claimIndex}`} className="my-2">
                <div className="h-36 rounded-lg border border-gray-50 p-2">
                  <ScrollArea className="h-full">{claim.claim}</ScrollArea>
                </div>
                <div ref={parent}>
                  {claim.elements.map((element, elementIndex) => (
                    <ClaimDisplay
                      key={`clam-ele-${claimIndex}-${elementIndex}`}
                      claimIndex={claimIndex}
                      elementIndex={elementIndex}
                      handleElementChange={handleElementChange}
                      addElement={addElement}
                      deleteElement={deleteElement}
                      element={element}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </main>
      <div className="lg:w-64 lg:p-4"></div>
    </div>
  );
}

interface ElementDisplayProps {
  element: Element;
  claimIndex: number;
  elementIndex: number;
  handleElementChange: (
    claimIndex: number,
    elementIndex: number,
    newValue: string,
  ) => void;
  addElement: (claimIndex: number, elementIndex: number) => void;
  deleteElement: (claimIndex: number, elementIndex: number) => void;
}
function ClaimDisplay({
  element,
  claimIndex,
  elementIndex,
  handleElementChange,
  addElement,
  deleteElement,
}: ElementDisplayProps) {
  const [showQuote, setShowQuote] = useState<Record<number, boolean>>({});
  const [showDialog, setShowDialog] = useState(false);
  const [dialogContent, setDialogContent] = useState<string | null>(null);

  const toggleQuote = (elementIndex: number) => {
    setShowQuote((prev) => ({ ...prev, [elementIndex]: !prev[elementIndex] }));
  };

  const openDialog = (cite: string | undefined) => {
    setDialogContent(cite ?? "No citation available");
    setShowDialog(true);
  };
  const [parent] = useAutoAnimate();

  return (
    <div ref={parent} key={`${claimIndex}-${elementIndex}`}>
      <div className="my-2 flex w-full flex-row items-center justify-between">
        <textarea
          value={element.element}
          onChange={(e) =>
            handleElementChange(claimIndex, elementIndex, e.target.value)
          }
          className="w-full resize-none overflow-hidden rounded-md border-gray-200 px-3 py-2 text-sm ring-offset-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-950 focus:ring-offset-2"
          style={{
            minHeight: "2rem",
          }}
          placeholder="Enter element details..."
        />
        <div className="flex items-center justify-center px-1 pl-2">
          {element.disclosed !== undefined ? (
            element.disclosed ? (
              <HoverCard>
                <HoverCardTrigger>
                  <Ban className="text-red-500" />
                </HoverCardTrigger>
                <HoverCardContent className="w-auto">
                  Disclosed
                </HoverCardContent>
              </HoverCard>
            ) : (
              <HoverCard>
                <HoverCardTrigger>
                  <Check className="text-green-600" />
                </HoverCardTrigger>
                <HoverCardContent className="w-auto">
                  Not Disclosed
                </HoverCardContent>
              </HoverCard>
            )
          ) : (
            <></>
          )}
        </div>
        <div className="flex flex-col items-center justify-center">
          <div className="flex flex-row gap-x-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => addElement(claimIndex, elementIndex)}
              className="h-8"
            >
              <Plus className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => deleteElement(claimIndex, elementIndex)}
              className="h-8"
            >
              <Trash2 className="h-4 w-4 text-red-500" />
            </Button>
          </div>

          <div className="flex flex-row items-center justify-center gap-x-2 p-1">
            {/* Disclosed state */}
            {element.disclosed && (
              <div className="mt-1 flex flex-row items-center justify-center gap-x-2">
                {/* Button to toggle quote */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => toggleQuote(elementIndex)}
                >
                  {showQuote[elementIndex] ? "Hide Quote" : "Show Quote"}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Conditional rendering of the quote */}
      {showQuote[elementIndex] && element.quote && (
        <div className="flex flex-row items-center justify-between">
          <div className="mt-2 text-sm text-gray-600">{element.quote}</div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => openDialog(element.cite)}
          >
            Cite
          </Button>
        </div>
      )}

      {/* Dialog for citation */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Citation</DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[500px]">
            <div>{element.cite}</div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
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
        <div className="h-24 w-full rounded-[var(--radius)] border border-dashed border-[hsl(var(--foreground))] bg-[hsl(var(--background))] text-sm text-[hsl(var(--foreground))] hover:bg-[hsl(var(--border))]">
          <div
            {...getRootProps()}
            className="flex h-full w-full flex-col items-center justify-center p-2"
          >
            <label
              htmlFor="dropzone-file"
              className="flex h-full w-full cursor-pointer flex-col items-center justify-center rounded-[var(--radius)] hover:bg-[hsl(var(--accent))/0.25]"
            >
              <div className="flex w-full flex-col items-center justify-center pt-2 text-[hsl(var(--foreground))]">
                {label()}
              </div>
              <div className="text-[hsl(var(--foreground))]">
                <Cloud className="h-8 w-8" />
              </div>
              <p className="mb-2 flex w-full flex-col items-center justify-center text-sm">
                <span className="font-semibold">Click to upload</span>
                <span>or drag and drop</span>
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
