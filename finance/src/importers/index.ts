import { csvProvider } from "./csv";
import { ofxProvider } from "./ofx";
import { PROVIDERS } from "@/lib/bank-provider";

PROVIDERS[csvProvider.id] = csvProvider;
PROVIDERS[ofxProvider.id] = ofxProvider;

export { csvProvider, ofxProvider };
export { PROVIDERS };