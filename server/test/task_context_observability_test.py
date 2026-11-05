import sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from task_context import build_context, serialize_context, context_observations
from unittest.mock import patch
class ObservabilityTest(unittest.TestCase):
 def test_sources_remain_distinct_and_truncation_is_visible(self):
  excerpts=[{"source":"kb","title":"lesson","excerpt":"x"*800}]
  with patch("task_context._knowledge_from_kb",return_value=("ok",excerpts)):
   ctx=build_context({"id":"a","title":"t"},{"id":"r"})
  full=context_observations(ctx,serialize_context(ctx))
  kb=next(x for x in full if x["scenario"]=="kb")
  self.assertEqual(kb["outputCount"],1)
  self.assertEqual(kb["items"],[{"title":"lesson","source":"kb","chars":800,"excerpt":"x"*400}])
  self.assertNotIn("mnemosyne",[x["scenario"] for x in full])
  clipped=context_observations(ctx,serialize_context(ctx,150))
  self.assertEqual(next(x for x in clipped if x["scenario"]=="kb")["outputCount"],0)
  self.assertEqual(next(x for x in clipped if x["scenario"]=="kb")["inputCount"],1)
  self.assertEqual(next(x for x in clipped if x["scenario"]=="kb")["items"],[])
if __name__=="__main__":unittest.main()
