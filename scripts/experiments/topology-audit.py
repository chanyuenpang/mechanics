"""只读检查冻结样本的平面性，输出嵌入或不可平面证据。"""
import argparse
import hashlib
import json
from pathlib import Path
import networkx as nx


def audit(path):
    raw = path.read_bytes()
    sample = json.loads(raw)
    graph = nx.Graph()
    graph.add_nodes_from(node['id'] for node in sample['graph']['nodes'])
    graph.add_edges_from((edge['source'], edge['target']) for edge in sample['graph']['edges'])
    planar, certificate = nx.check_planarity(graph, counterexample=True)
    return {
        'sample': sample['id'], 'inputFileSha256': hashlib.sha256(raw).hexdigest(),
        'nodes': graph.number_of_nodes(), 'originalEdges': len(sample['graph']['edges']),
        'simpleEdges': graph.number_of_edges(), 'planar': planar,
        'certificate': certificate.get_data() if planar else list(certificate.edges()),
        'bridges': list(nx.bridges(graph)),
        'blocks': sorted((len(block) for block in nx.biconnected_components(graph)), reverse=True),
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('inputs', nargs='+', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = {'networkx': nx.__version__, 'samples': [audit(path) for path in args.inputs]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps([{key: item[key] for key in ['sample', 'nodes', 'originalEdges', 'planar', 'blocks']} for item in result['samples']]))
