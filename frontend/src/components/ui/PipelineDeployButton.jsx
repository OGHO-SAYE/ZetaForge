import { useMutation } from "@tanstack/react-query";
import { Deploy } from "@carbon/icons-react";
import { Button } from "@carbon/react";
import { deployPipeline } from "@/client/anvil";
import { useQueryClient } from "@tanstack/react-query";

export const PipelineDeployButton = ({ uuid, hash, configuration }) => {
  const queryClient = useQueryClient();
  const deploy = useMutation({
    mutationFn: async () => {
      return await deployPipeline(configuration, uuid, hash);
    },
    onSuccess: () => {
      // Update the React Query cache
      const queryKey = ["pipelines", configuration?.anvil?.host];
      queryClient.setQueryData(queryKey, (pipelines) => {
        return pipelines?.body.map((pipeline) => {
          if (pipeline.Hash === hash) {
            // Update the deployed status of the matching pipeline
            const newPipeline = {
              ...pipeline,
              Deployed: true,
            };
            return newPipeline;
          }
          return pipeline;
        });
      });
    },
  });

  const mutationAction = async () => {
    try {
      await deploy.mutateAsync();
    } catch (error) {
      // todo pop error modal
      console.error("Failed to deploy pipeline:", error);
    }
  };

  const svgOverride = { position: "absolute", right: "15px", top: "5px" };
  const zIndex = { zIndex: 1 };

  let deployButton = (
    <div style={zIndex}>
      Deploy
      <Deploy size="20" style={svgOverride} />
    </div>
  );

  return (
    <Button size="sm" onClick={() => mutationAction()}>
      {deployButton}
    </Button>
  );
};